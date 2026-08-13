import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyManifestPayload,
  verifySignedReleaseEnvelope,
} from "../src/onboarding/adapters/filesystem/release-verifier.js";
import { runCommand } from "../src/onboarding/adapters/process/command-runner.js";
import { redactText } from "../src/onboarding/cli/output.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function argumentsFor(name: string): readonly string[] {
  return process.argv.flatMap((entry, index) => {
    const value = process.argv[index + 1];
    return entry === name && value !== undefined ? [value] : [];
  });
}

async function pinVerifiedArchive(
  sourcePath: string,
  targetPath: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<void> {
  const source = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const target = await open(
    targetPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const before = await source.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(expectedSize)
    ) {
      throw new Error("Release archive changed after envelope verification");
    }
    const digest = createHash("sha256");
    for await (const chunk of source.createReadStream({
      autoClose: false,
    }) as AsyncIterable<Buffer>) {
      digest.update(chunk);
      await target.write(chunk);
    }
    await target.sync();
    const after = await source.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      digest.digest("hex") !== expectedSha256
    ) {
      throw new Error("Release archive changed after envelope verification");
    }
  } finally {
    await target.close();
    await source.close();
  }
}

function validateArchiveListings(names: string, verbose: string): void {
  const entries = names.split("\n").filter(Boolean);
  const verboseEntries = verbose.split("\n").filter(Boolean);
  if (
    entries.length < 1 ||
    entries.length > 8192 ||
    entries.length !== verboseEntries.length
  ) {
    throw new Error(
      "Release archive inventory is empty, inconsistent, or too large",
    );
  }
  entries.forEach((raw, index) => {
    const type = verboseEntries[index]?.[0];
    if (type !== "-" && type !== "d")
      throw new Error("Release archive contains a link or special entry");
    if (!/^[A-Za-z0-9@+_,=./-]+\/?$/.test(raw))
      throw new Error("Release archive listing is invalid");
    const unprefixed = raw.startsWith("./") ? raw.slice(2) : raw;
    const path = unprefixed.endsWith("/")
      ? unprefixed.slice(0, -1)
      : unprefixed;
    if ((path === "" || path === ".") && type === "d") return;
    if (
      path.startsWith("/") ||
      path.split("/").some((segment) => segment === "" || segment === "..") ||
      path.includes("\0")
    ) {
      throw new Error("Release archive contains an unsafe path");
    }
  });
}

export async function verifyCandidateFromCommandLine(): Promise<void> {
  const manifestPath = argument("--manifest");
  const bundlePaths = argumentsFor("--bundle");
  const bundlePath = bundlePaths[0];
  const archive = argument("--archive");
  const policyPath = argument("--policy");
  const trustedRootPath = argument("--trusted-root");
  const cosign = argument("--cosign");
  const architecture = argument("--architecture");
  if (
    manifestPath === undefined ||
    bundlePath === undefined ||
    archive === undefined ||
    policyPath === undefined ||
    trustedRootPath === undefined ||
    cosign === undefined ||
    (architecture !== "amd64" && architecture !== "arm64")
  ) {
    throw new Error(
      "Usage: verify-self-hosted-release --manifest PATH --bundle PATH --archive PATH --policy PATH --trusted-root PATH --cosign PATH --architecture amd64|arm64",
    );
  }
  const verified = await verifySignedReleaseEnvelope({
    manifestPath: resolve(manifestPath),
    bundlePath: resolve(bundlePath),
    bundlePaths: bundlePaths.map((path) => resolve(path)),
    archive: resolve(archive),
    policyPath: resolve(policyPath),
    trustedRootPath: resolve(trustedRootPath),
    cosign: resolve(cosign),
    architecture,
    currentReleaseSequence: Number(
      argument("--current-release-sequence") ?? "0",
    ),
    currentTrustSequence: Number(argument("--current-trust-sequence") ?? "0"),
  });
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "skillwire-release-verify-"),
  );
  const extractionRoot = resolve(temporaryRoot, "payload");
  const pinnedArchive = resolve(temporaryRoot, "release.tar.zst");
  try {
    await mkdir(extractionRoot, { mode: 0o700 });
    await pinVerifiedArchive(
      resolve(archive),
      pinnedArchive,
      verified.manifest.archive.size,
      verified.archiveSha256,
    );
    const listed = await runCommand({
      executable: "/usr/bin/tar",
      args: [
        "--use-compress-program=/usr/bin/zstd",
        "--quoting-style=escape",
        "-tf",
        pinnedArchive,
      ],
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      deadlineMilliseconds: 30_000,
      maximumOutputBytes: 512 * 1024,
    });
    const verbose = await runCommand({
      executable: "/usr/bin/tar",
      args: [
        "--use-compress-program=/usr/bin/zstd",
        "--quoting-style=escape",
        "-tvf",
        pinnedArchive,
      ],
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      deadlineMilliseconds: 30_000,
      maximumOutputBytes: 512 * 1024,
    });
    validateArchiveListings(listed.stdout, verbose.stdout);
    await runCommand({
      executable: "/usr/bin/tar",
      args: [
        "--use-compress-program=/usr/bin/zstd",
        "--no-same-owner",
        "--no-same-permissions",
        "-xf",
        pinnedArchive,
        "-C",
        extractionRoot,
      ],
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      deadlineMilliseconds: 60_000,
      maximumOutputBytes: 64 * 1024,
    });
    await verifyManifestPayload(verified.manifest, extractionRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write(
    `${JSON.stringify({
      verified: true,
      releaseVersion: verified.releaseVersion,
      releaseSequence: verified.releaseSequence,
      trustPolicySequence: verified.trustPolicySequence,
      manifestSha256: verified.manifestSha256,
      archiveSha256: verified.archiveSha256,
    })}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  verifyCandidateFromCommandLine().catch((error: unknown) => {
    process.stderr.write(
      `${redactText(error instanceof Error ? error.message : "Release verification failed")}\n`,
    );
    process.exitCode = 12;
  });
}
