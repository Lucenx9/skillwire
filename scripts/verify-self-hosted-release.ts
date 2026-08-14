import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  verifyManifestPayload,
  verifySignedReleaseEnvelope,
} from "../src/onboarding/adapters/filesystem/release-verifier.js";
import { runCommand } from "../src/onboarding/adapters/process/command-runner.js";
import { redactText } from "../src/onboarding/cli/output.js";
import type { ReleaseManifest } from "../src/onboarding/domain/release-manifest.js";
import { validateCodexAdapterIntegrityManifest } from "../src/evaluation/codex-adapter-package.js";
import { verifyBundledFirstPartyCatalog } from "../src/onboarding/application/first-party-catalog.js";

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

export async function pinVerifiedArchive(
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

export function validateArchiveListings(names: string, verbose: string): void {
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
  const normalize = (raw: string, type: string | undefined): string => {
    if (type !== "-" && type !== "d")
      throw new Error("Release archive contains a link or special entry");
    if (!/^[A-Za-z0-9@+_,=./-]+\/?$/.test(raw))
      throw new Error("Release archive listing is invalid");
    const unprefixed = raw.startsWith("./") ? raw.slice(2) : raw;
    const path = unprefixed.endsWith("/")
      ? unprefixed.slice(0, -1)
      : unprefixed;
    if ((path === "" || path === ".") && type === "d") return ".";
    if (
      path.startsWith("/") ||
      path
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        ) ||
      path.includes("\0")
    ) {
      throw new Error("Release archive contains an unsafe path");
    }
    return path;
  };
  const normalized = entries.map((raw, index) => {
    const type = verboseEntries[index]?.[0];
    const path = normalize(raw, type);
    const verbosePath = verboseEntries[index]?.trim().split(/\s+/).at(-1);
    if (verbosePath === undefined || normalize(verbosePath, type) !== path)
      throw new Error("Release archive listings disagree");
    return path;
  });
  if (new Set(normalized).size !== normalized.length)
    throw new Error("Release archive contains duplicate paths");
}

const CertifiedMatrixSchema = z
  .object({
    schemaVersion: z.literal("skillwire.supported-matrix/v1"),
    operatingSystems: z.tuple([
      z
        .object({ id: z.literal("ubuntu"), version: z.literal("24.04") })
        .strict(),
      z.object({ id: z.literal("debian"), version: z.literal("12") }).strict(),
      z.object({ id: z.literal("debian"), version: z.literal("13") }).strict(),
    ]),
    architectures: z.tuple([z.literal("amd64"), z.literal("arm64")]),
    docker: z
      .object({
        minimum: z.literal("29.7.2"),
        tested: z.string().regex(/^\d+\.\d+\.\d+$/),
      })
      .strict(),
    compose: z
      .object({
        minimum: z.literal("5.4.0"),
        tested: z.string().regex(/^\d+\.\d+\.\d+$/),
      })
      .strict(),
    postgresql: z.literal("17.10-alpine"),
    node: z.literal("24.18.0"),
    codex: z.literal("0.147.0"),
    claude: z.literal("2.1.229"),
    cosign: z.literal("3.1.3"),
  })
  .strict();

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Production Compose policy is invalid");
  return value as Record<string, unknown>;
}

function stringList(value: unknown): readonly string[] {
  const parsed = z.array(z.string()).safeParse(value);
  if (!parsed.success) throw new Error("Production Compose policy is invalid");
  return parsed.data;
}

function requireExactStrings(
  value: unknown,
  expected: readonly string[],
): void {
  const actual = stringList(value);
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error("Production Compose policy is unsafe");
  }
}

const FORBIDDEN_SERVICE_CONTROLS = new Set([
  "build",
  "cgroup",
  "cgroup_parent",
  "configs",
  "device_cgroup_rules",
  "devices",
  "dns",
  "dns_search",
  "extra_hosts",
  "ipc",
  "links",
  "network_mode",
  "pid",
  "ports",
  "privileged",
  "uts",
  "volumes_from",
]);

function rejectForbiddenServiceControls(
  service: Record<string, unknown>,
): void {
  if ([...FORBIDDEN_SERVICE_CONTROLS].some((key) => key in service))
    throw new Error("Production Compose policy is unsafe");
}

function verifyProductionCompose(value: unknown): void {
  const compose = record(value);
  const services = record(compose["services"]);
  const serviceNames = Object.keys(services).toSorted();
  if (
    JSON.stringify(serviceNames) !==
    JSON.stringify(["admin", "migrate", "postgres", "skillwire"])
  ) {
    throw new Error("Production Compose policy is unsafe");
  }
  const postgres = record(services["postgres"]);
  const migrate = record(services["migrate"]);
  const skillwire = record(services["skillwire"]);
  const admin = record(services["admin"]);
  for (const service of [postgres, migrate, skillwire, admin])
    rejectForbiddenServiceControls(service);

  if (
    compose["name"] !==
      "${SKILLWIRE_COMPOSE_PROJECT:?compose project is required}" ||
    postgres["image"] !==
      "${SKILLWIRE_POSTGRES_IMAGE:?digest-pinned PostgreSQL image is required}" ||
    migrate["image"] !==
      "${SKILLWIRE_IMAGE:?digest-pinned SkillWire image is required}" ||
    skillwire["image"] !==
      "${SKILLWIRE_IMAGE:?digest-pinned SkillWire image is required}" ||
    admin["image"] !==
      "${SKILLWIRE_IMAGE:?digest-pinned SkillWire image is required}" ||
    migrate["read_only"] !== true ||
    skillwire["read_only"] !== true ||
    admin["read_only"] !== true
  ) {
    throw new Error("Production Compose policy is unsafe");
  }

  requireExactStrings(postgres["cap_drop"], ["ALL"]);
  requireExactStrings(postgres["cap_add"], [
    "CHOWN",
    "DAC_OVERRIDE",
    "FOWNER",
    "SETGID",
    "SETUID",
  ]);
  requireExactStrings(migrate["cap_drop"], ["ALL"]);
  requireExactStrings(migrate["cap_add"], [
    "CHOWN",
    "DAC_OVERRIDE",
    "SETGID",
    "SETUID",
  ]);
  requireExactStrings(skillwire["cap_drop"], ["ALL"]);
  requireExactStrings(skillwire["cap_add"], [
    "CHOWN",
    "DAC_OVERRIDE",
    "SETGID",
    "SETUID",
  ]);
  requireExactStrings(admin["cap_drop"], ["ALL"]);
  for (const service of [postgres, migrate, skillwire, admin])
    requireExactStrings(service["security_opt"], ["no-new-privileges:true"]);

  requireExactStrings(postgres["volumes"], [
    "postgres_data:/var/lib/postgresql/data",
  ]);
  requireExactStrings(skillwire["volumes"], [
    "${SKILLWIRE_RUNTIME_SOCKET_DIRECTORY:?runtime socket directory is required}:/run/skillwire:rw",
  ]);
  if ("volumes" in migrate || "volumes" in admin)
    throw new Error("Production Compose policy is unsafe");

  const volumes = record(compose["volumes"]);
  const postgresVolume = record(volumes["postgres_data"]);
  if (
    Object.keys(volumes).length !== 1 ||
    postgresVolume["name"] !==
      "${SKILLWIRE_POSTGRES_VOLUME:?owned PostgreSQL volume is required}" ||
    Object.keys(postgresVolume).length !== 1 ||
    "networks" in compose ||
    "configs" in compose
  ) {
    throw new Error("Production Compose policy is unsafe");
  }
}

export async function verifySelfHostedReleasePolicy(
  manifest: ReleaseManifest,
  releaseRoot: string,
): Promise<{
  readonly feature003PackageSha256: string;
  readonly firstPartyRevisionCount: 10;
  readonly matrix: z.infer<typeof CertifiedMatrixSchema>;
}> {
  const composeText = await readFile(
    resolve(releaseRoot, "distribution/self-hosted/compose.yaml"),
    "utf8",
  );
  verifyProductionCompose(parseYaml(composeText) as unknown);
  const matrixResult = CertifiedMatrixSchema.safeParse(
    JSON.parse(
      await readFile(
        resolve(releaseRoot, "distribution/self-hosted/supported-matrix.json"),
        "utf8",
      ),
    ) as unknown,
  );
  if (!matrixResult.success)
    throw new Error("Certified release matrix is invalid or overclaimed");
  const matrix = matrixResult.data;
  const integrity = validateCodexAdapterIntegrityManifest(
    JSON.parse(
      await readFile(
        resolve(
          releaseRoot,
          "distribution/codex-marketplace/release-integrity.json",
        ),
        "utf8",
      ),
    ) as unknown,
    resolve(releaseRoot, "integrations/codex/skillwire-autonomous-activation"),
  );
  const catalog = await verifyBundledFirstPartyCatalog({
    releaseRoot,
    release: manifest,
  });
  return {
    feature003PackageSha256: integrity.packageSha256,
    firstPartyRevisionCount: catalog.revisions.length as 10,
    matrix,
  };
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
    await verifySelfHostedReleasePolicy(verified.manifest, extractionRoot);
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
