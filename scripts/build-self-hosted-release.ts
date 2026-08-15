import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReleaseManifest } from "../src/onboarding/domain/release-manifest.js";
import {
  ReleaseManifestSchema,
  TrustPolicySchema,
} from "../src/onboarding/domain/release-manifest.js";
import { deriveReleaseComponents } from "../src/onboarding/domain/release-components.js";
import { runCommand } from "../src/onboarding/adapters/process/command-runner.js";
import { redactText } from "../src/onboarding/cli/output.js";

export interface BuildReleaseOptions {
  readonly payloadRoot: string;
  readonly outputDirectory: string;
  readonly architecture: "amd64" | "arm64";
  readonly releaseVersion: string;
  readonly releaseSequence: number;
  readonly publishedAt: string;
  readonly sourceCommit: string;
  readonly trustPolicySequence: number;
  readonly trustPolicyPath?: string | undefined;
  readonly images: ReleaseManifest["images"];
  readonly tarExecutable?: string | undefined;
  readonly zstdExecutable?: string | undefined;
}

export interface BuiltRelease {
  readonly archivePath: string;
  readonly manifestPath: string;
  readonly manifest: ReleaseManifest;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(
  path: string,
  maximumBytes: number,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const before = await stat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > BigInt(maximumBytes)
  ) {
    throw new Error("Release output is unsafe or too large");
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    digest.update(chunk);
  }
  const after = await stat(path, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw new Error("Release output changed while hashing");
  }
  return { size: Number(before.size), sha256: digest.digest("hex") };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported manifest value");
}

async function inventory(root: string): Promise<ReleaseManifest["payload"]> {
  const entries: ReleaseManifest["payload"][number][] = [];
  async function visit(directory: string): Promise<void> {
    const names = (await readdir(directory)).toSorted();
    for (const name of names) {
      const path = join(directory, name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink())
        throw new Error("Release payload contains a symbolic link");
      if (stats.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1)
        throw new Error("Release payload must contain single regular files");
      const mode = stats.mode & 0o777;
      if (![0o600, 0o644, 0o700, 0o755].includes(mode))
        throw new Error("Release payload contains an unsupported file mode");
      const bytes = await readFile(path);
      entries.push({
        path: relative(root, path).split(sep).join("/"),
        size: bytes.byteLength,
        sha256: sha256(bytes),
        mode: mode.toString(8).padStart(4, "0") as
          "0600" | "0644" | "0700" | "0755",
      });
    }
  }
  await visit(root);
  return entries;
}

export async function buildSelfHostedRelease(
  options: BuildReleaseOptions,
): Promise<BuiltRelease> {
  const payloadRoot = resolve(options.payloadRoot);
  const outputDirectory = resolve(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const payload = await inventory(payloadRoot);
  for (const [path, mode] of [
    ["bin/skillwire", "0755"],
    ["runtime/node", "0755"],
    ["app/skillwire.mjs", "0644"],
    ["distribution/self-hosted/compose.yaml", "0644"],
  ] as const) {
    const entry = payload.find((candidate) => candidate.path === path);
    if (entry?.mode !== mode) {
      throw new Error(
        `Release payload is missing required ${path} mode ${mode}`,
      );
    }
  }
  const feature003Integrity = payload.find(
    ({ path }) =>
      path === "distribution/codex-marketplace/release-integrity.json",
  );
  if (feature003Integrity === undefined)
    throw new Error(
      "Feature 003 release integrity metadata is missing from payload",
    );
  const releaseBase = `skillwire-${options.releaseVersion}-linux-${options.architecture}`;
  const archiveName = `${releaseBase}.tar.zst`;
  const archivePath = resolve(outputDirectory, archiveName);
  const manifestPath = resolve(outputDirectory, `${releaseBase}.release.json`);
  for (const outputPath of [archivePath, manifestPath]) {
    try {
      await lstat(outputPath);
      throw new Error("Release output already exists");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  const tarPath = resolve(outputDirectory, `.${archiveName}.tar`);
  await runCommand({
    executable: options.tarExecutable ?? "/usr/bin/tar",
    args: [
      "--sort=name",
      "--format=ustar",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-C",
      payloadRoot,
      "-cf",
      tarPath,
      ".",
    ],
    environment: { PATH: "/usr/bin:/bin", LANG: "C" },
    deadlineMilliseconds: 60_000,
  });
  try {
    await runCommand({
      executable: options.zstdExecutable ?? "/usr/bin/zstd",
      args: [
        "-q",
        "-19",
        "--threads=1",
        "--no-progress",
        tarPath,
        "-o",
        archivePath,
      ],
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      deadlineMilliseconds: 60_000,
    });
  } catch (error) {
    await unlink(archivePath).catch(() => undefined);
    throw error;
  } finally {
    await unlink(tarPath).catch(() => undefined);
  }
  const archiveIdentity = await hashFile(archivePath, 16 * 1024 ** 3);
  const trustPolicyBytes = await readFile(
    resolve(
      options.trustPolicyPath ??
        "distribution/self-hosted/trust-policy.v1.json",
    ),
  );
  const trustPolicy = TrustPolicySchema.parse(
    JSON.parse(trustPolicyBytes.toString("utf8")) as unknown,
  );
  if (
    trustPolicy.sequence !== options.trustPolicySequence ||
    canonical(trustPolicy) !== trustPolicyBytes.toString("utf8")
  ) {
    throw new Error("Release trust policy identity is invalid");
  }
  const activeSigners = trustPolicy.signers.filter(
    ({ signerId, issuer, repository, workflow, refPattern }) => {
      const cryptographicIdentity = [
        issuer,
        repository,
        workflow,
        refPattern,
      ].join("|");
      return (
        !trustPolicy.deniedSigners.includes(signerId) &&
        !trustPolicy.deniedSigners.includes(cryptographicIdentity)
      );
    },
  );
  const signatureSigners = activeSigners.slice(
    0,
    trustPolicy.overlap.requiredSignerCount,
  );
  if (signatureSigners.length !== trustPolicy.overlap.requiredSignerCount) {
    throw new Error("Release trust policy has insufficient active signers");
  }
  const manifest = ReleaseManifestSchema.parse({
    schemaVersion: "skillwire.release/v1",
    releaseVersion: options.releaseVersion,
    releaseSequence: options.releaseSequence,
    publishedAt: options.publishedAt,
    sourceCommit: options.sourceCommit,
    trustPolicySequence: options.trustPolicySequence,
    trustPolicy: {
      path: `skillwire-trust-policy-v${String(options.trustPolicySequence)}.json`,
      size: trustPolicyBytes.byteLength,
      sha256: sha256(trustPolicyBytes),
    },
    signatureBundles: signatureSigners.map(({ signerId }, index) => ({
      signerId,
      path:
        index === 0
          ? `${releaseBase}.release.sigstore.json`
          : `${releaseBase}.release.${signerId}.sigstore.json`,
    })),
    architecture: options.architecture,
    archive: {
      path: archiveName,
      size: archiveIdentity.size,
      sha256: archiveIdentity.sha256,
    },
    payload,
    images: options.images,
    compatibility: {
      node: "24.18.0",
      postgresql: "17.10",
      schemaMinimum: 10,
      schemaMaximum: 10,
    },
    feature003Integrity: {
      path: feature003Integrity.path,
      size: feature003Integrity.size,
      sha256: feature003Integrity.sha256,
    },
    components: deriveReleaseComponents(payload),
  });
  try {
    await writeFile(manifestPath, canonical(manifest), {
      mode: 0o644,
      flag: "wx",
    });
  } catch (error) {
    await unlink(archivePath).catch(() => undefined);
    throw error;
  }
  return { archivePath, manifestPath, manifest };
}

async function main(): Promise<void> {
  const payloadRoot = process.argv[2];
  const outputDirectory = process.argv[3];
  const architecture = process.argv[4];
  if (
    payloadRoot === undefined ||
    outputDirectory === undefined ||
    (architecture !== "amd64" && architecture !== "arm64")
  ) {
    throw new Error(
      "Usage: build-self-hosted-release <payload-root> <output-directory> <amd64|arm64>",
    );
  }
  const imagesJson = process.env["SKILLWIRE_RELEASE_IMAGES_JSON"];
  if (imagesJson === undefined) {
    throw new Error("SKILLWIRE_RELEASE_IMAGES_JSON is required");
  }
  const images = ReleaseManifestSchema.shape.images.parse(
    JSON.parse(imagesJson) as unknown,
  );
  const packageVersion = ReleaseManifestSchema.shape.releaseVersion.parse(
    (
      JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
        version?: unknown;
      }
    ).version,
  );
  const releaseVersion =
    process.env["SKILLWIRE_RELEASE_VERSION"] ?? packageVersion;
  if (releaseVersion !== packageVersion)
    throw new Error("Release version does not match package.json");
  await buildSelfHostedRelease({
    payloadRoot,
    outputDirectory,
    architecture,
    releaseVersion,
    releaseSequence: Number(process.env["SKILLWIRE_RELEASE_SEQUENCE"] ?? "1"),
    publishedAt:
      process.env["SKILLWIRE_PUBLISHED_AT"] ?? "1970-01-01T00:00:00.000Z",
    sourceCommit: process.env["GITHUB_SHA"] ?? "0".repeat(40),
    trustPolicySequence: Number(process.env["SKILLWIRE_TRUST_SEQUENCE"] ?? "1"),
    images,
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${redactText(error instanceof Error ? error.message : "Release build failed")}\n`,
    );
    process.exitCode = 1;
  });
}
