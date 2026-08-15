import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

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
    dockerModes: z.tuple([z.literal("rootful"), z.literal("rootless")]),
    certification: z
      .object({
        cellCount: z.literal(12),
        observationsPerCell: z.literal("exactly-one"),
        releaseIdentity: z.literal("same-final-tag-and-seven-assets"),
        failedOrIncomplete: z.literal(
          "not-certified-no-replacement-or-exclusion",
        ),
      })
      .strict(),
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

const EXPECTED_PRODUCTION_COMPOSE = {
  name: "${SKILLWIRE_COMPOSE_PROJECT:?compose project is required}",
  services: {
    postgres: {
      image:
        "${SKILLWIRE_POSTGRES_IMAGE:?digest-pinned PostgreSQL image is required}",
      environment: {
        POSTGRES_DB: "skillwire",
        POSTGRES_USER: "skillwire",
        POSTGRES_PASSWORD_FILE: "/run/secrets/database_password",
      },
      secrets: [
        {
          source: "postgres_password",
          target: "database_password",
          mode: 400,
        },
      ],
      volumes: ["postgres_data:/var/lib/postgresql/data"],
      healthcheck: {
        test: ["CMD-SHELL", "pg_isready -U skillwire -d skillwire"],
        interval: "5s",
        timeout: "3s",
        retries: 20,
      },
      restart: "unless-stopped",
      stop_grace_period: "15s",
      cap_drop: ["ALL"],
      cap_add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
      security_opt: ["no-new-privileges:true"],
    },
    migrate: {
      image: "${SKILLWIRE_IMAGE:?digest-pinned SkillWire image is required}",
      entrypoint: ["/usr/local/bin/skillwire-secret-entrypoint"],
      command: [
        "database",
        "node",
        "dist/src/persistence/postgres/migration-runner.js",
      ],
      user: "0:0",
      environment: {
        SKILLWIRE_DATABASE_PASSWORD_FILE: "/run/secrets/database_password",
        SKILLWIRE_DATABASE_HOST: "postgres",
      },
      secrets: [
        {
          source: "postgres_password",
          target: "database_password",
          mode: 400,
        },
      ],
      depends_on: { postgres: { condition: "service_healthy" } },
      read_only: true,
      tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
      cap_drop: ["ALL"],
      cap_add: ["CHOWN", "DAC_OVERRIDE", "SETGID", "SETUID"],
      security_opt: ["no-new-privileges:true"],
      restart: "no",
    },
    skillwire: {
      image: "${SKILLWIRE_IMAGE:?digest-pinned SkillWire image is required}",
      entrypoint: ["/usr/local/bin/skillwire-secret-entrypoint"],
      command: ["application", "node", "dist/src/main.js"],
      user: "0:0",
      environment: {
        SKILLWIRE_DATABASE_PASSWORD_FILE: "/run/secrets/database_password",
        SKILLWIRE_DATABASE_HOST: "postgres",
        SKILLWIRE_API_KEY_PEPPER_FILE: "/run/secrets/application_pepper",
        SKILLWIRE_BIND_HOST: "localhost",
        SKILLWIRE_UNIX_SOCKET_PATH: "/run/skillwire/mcp.sock",
        SKILLWIRE_RUNTIME_UID:
          "${SKILLWIRE_RUNTIME_UID:?runtime uid is required}",
        SKILLWIRE_RUNTIME_GID:
          "${SKILLWIRE_RUNTIME_GID:?runtime gid is required}",
        SKILLWIRE_ALLOWED_HOSTS: "localhost,127.0.0.1",
        SKILLWIRE_CATALOG_ROOT: "/app",
        SKILLWIRE_CATALOG_RELEASE: "launch-catalog-v1",
        SKILLWIRE_AUTHENTICATION_REQUESTS_PER_MINUTE:
          "${SKILLWIRE_AUTHENTICATION_REQUESTS_PER_MINUTE:-600}",
        SKILLWIRE_AUTHENTICATION_RATE_LIMIT_BURST:
          "${SKILLWIRE_AUTHENTICATION_RATE_LIMIT_BURST:-60}",
        SKILLWIRE_GITHUB_INGESTION_ENABLED: "false",
      },
      secrets: [
        {
          source: "postgres_password",
          target: "database_password",
          mode: 400,
        },
        {
          source: "api_key_pepper",
          target: "application_pepper",
          mode: 400,
        },
      ],
      volumes: [
        "${SKILLWIRE_RUNTIME_SOCKET_DIRECTORY:?runtime socket directory is required}:/run/skillwire:rw",
      ],
      depends_on: {
        postgres: { condition: "service_healthy" },
        migrate: { condition: "service_completed_successfully" },
      },
      read_only: true,
      tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
      cap_drop: ["ALL"],
      cap_add: ["CHOWN", "DAC_OVERRIDE", "SETGID", "SETUID"],
      security_opt: ["no-new-privileges:true"],
      restart: "unless-stopped",
      stop_grace_period: "15s",
      healthcheck: {
        test: [
          "CMD",
          "node",
          "-e",
          "require('node:http').request({socketPath:'/run/skillwire/mcp.sock',path:'/health/ready',headers:{host:'localhost'}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).end()",
        ],
        interval: "10s",
        timeout: "3s",
        start_period: "15s",
        retries: 6,
      },
    },
    admin: {
      profiles: ["admin"],
      image: "${SKILLWIRE_IMAGE:?digest-pinned SkillWire image is required}",
      entrypoint: ["node", "dist/src/authentication/admin-cli.js"],
      environment: {
        SKILLWIRE_DATABASE_PASSWORD_FILE: "/run/secrets/database_password",
        SKILLWIRE_DATABASE_HOST: "postgres",
        SKILLWIRE_API_KEY_PEPPER_FILE: "/run/secrets/application_pepper",
      },
      secrets: [
        {
          source: "postgres_password",
          target: "database_password",
          mode: 400,
        },
        {
          source: "api_key_pepper",
          target: "application_pepper",
          mode: 400,
        },
      ],
      read_only: true,
      tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"],
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      logging: { driver: "none" },
      restart: "no",
    },
  },
  secrets: {
    postgres_password: {
      file: "${SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE:?database password file is required}",
    },
    api_key_pepper: {
      file: "${SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE:?application pepper file is required}",
    },
  },
  volumes: {
    postgres_data: {
      name: "${SKILLWIRE_POSTGRES_VOLUME:?owned PostgreSQL volume is required}",
    },
  },
} as const;

export function verifyProductionComposeText(composeText: string): void {
  if (
    !isDeepStrictEqual(
      parseYaml(composeText) as unknown,
      EXPECTED_PRODUCTION_COMPOSE,
    )
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
  verifyProductionComposeText(composeText);
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
