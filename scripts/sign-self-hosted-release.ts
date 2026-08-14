import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "../src/onboarding/adapters/process/command-runner.js";
import { redactText } from "../src/onboarding/cli/output.js";

export function signingArguments(
  manifestPath: string,
  bundlePath: string,
): string[] {
  return [
    "sign-blob",
    "--yes",
    "--timeout",
    "2m",
    "--oidc-provider",
    "github-actions",
    "--signing-algorithm",
    "ecdsa-sha2-256-nistp256",
    "--bundle",
    bundlePath,
    manifestPath,
  ];
}

export function overlapBundlePaths(
  primaryBundlePath: string,
  additionalSignerIds: readonly string[],
): readonly string[] {
  if (additionalSignerIds.length > 1)
    throw new Error("At most two signer bundles are supported");
  const seen = new Set<string>();
  const paths = [resolve(primaryBundlePath)];
  for (const signerId of additionalSignerIds) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(signerId) || seen.has(signerId)) {
      throw new Error("Signer overlap identity is invalid");
    }
    seen.add(signerId);
    const primary = resolve(primaryBundlePath);
    paths.push(
      primary.replace(/\.sigstore\.json$/, `.${signerId}.sigstore.json`),
    );
  }
  return paths;
}

export async function signSelfHostedRelease(options: {
  readonly cosignExecutable: string;
  readonly expectedCosignSha256: string;
  readonly manifestPath: string;
  readonly bundlePath: string;
  readonly additionalSignerIds?: readonly string[] | undefined;
}): Promise<readonly string[]> {
  const digest = createHash("sha256")
    .update(await readFile(options.cosignExecutable))
    .digest("hex");
  if (digest !== options.expectedCosignSha256)
    throw new Error(
      "Cosign binary hash does not match the pinned 3.1.3 release",
    );
  const bundlePaths = overlapBundlePaths(
    options.bundlePath,
    options.additionalSignerIds ?? [],
  );
  for (const bundlePath of bundlePaths) {
    await runCommand({
      executable: options.cosignExecutable,
      args: signingArguments(resolve(options.manifestPath), bundlePath),
      environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      deadlineMilliseconds: 120_000,
      maximumOutputBytes: 64 * 1024,
    });
  }
  return bundlePaths;
}

async function main(): Promise<void> {
  const cosignExecutable = process.argv[2];
  const expectedCosignSha256 = process.argv[3];
  const manifestPath = process.argv[4];
  const bundlePath = process.argv[5];
  if (
    cosignExecutable === undefined ||
    expectedCosignSha256 === undefined ||
    manifestPath === undefined ||
    bundlePath === undefined
  ) {
    throw new Error(
      "Usage: sign-self-hosted-release <cosign> <sha256> <manifest> <bundle>",
    );
  }
  await signSelfHostedRelease({
    cosignExecutable,
    expectedCosignSha256,
    manifestPath,
    bundlePath,
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${redactText(error instanceof Error ? error.message : "Release signing failed")}\n`,
    );
    process.exitCode = 1;
  });
}
