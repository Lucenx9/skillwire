import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import type {
  ReleaseManifest,
  TrustPolicy,
} from "../../src/onboarding/domain/release-manifest.js";
import { deriveReleaseComponents } from "../../src/onboarding/domain/release-components.js";

export const FIXTURE_ARCHIVE = Buffer.from(
  "bounded-self-hosted-archive",
  "utf8",
);

function catalogFixtureFiles(
  directory = "catalog",
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    readdirSync(resolve(process.cwd(), directory), { withFileTypes: true })
      .flatMap((entry): [string, string][] => {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory())
          return Object.entries(catalogFixtureFiles(path));
        if (!entry.isFile()) return [];
        return [[path, readFileSync(resolve(process.cwd(), path), "utf8")]];
      })
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

export const RELEASE_PAYLOAD_FILES: Readonly<Record<string, string>> = {
  "bin/skillwire": "#!/bin/sh\nexit 0\n",
  "runtime/node": "fixture-node-runtime",
  "app/skillwire.mjs": "fixture-main",
  "distribution/self-hosted/compose.yaml": "compose",
  "distribution/self-hosted/supported-matrix.json": readFileSync(
    resolve(process.cwd(), "distribution/self-hosted/supported-matrix.json"),
    "utf8",
  ),
  "distribution/codex-marketplace/release-integrity.json": "integrity",
  "distribution/codex-marketplace/marketplace.json": "codex-marketplace",
  "distribution/codex-release-marketplace/.agents/plugins/marketplace.json":
    "codex-release-marketplace",
  "distribution/codex-release-marketplace/plugins/skillwire-autonomous-activation/.codex-plugin/plugin.json":
    "codex-release-plugin",
  "distribution/codex-release-marketplace/plugins/skillwire-autonomous-activation/skills/autonomous-skill-activation/SKILL.md":
    "codex-release-skill",
  "distribution/codex-release-marketplace/plugins/skillwire-autonomous-activation/skills/autonomous-skill-activation/agents/openai.yaml":
    "codex-release-agent",
  "integrations/codex/skillwire-autonomous-activation/.codex-plugin/plugin.json":
    "codex-plugin",
  "distribution/claude-marketplace/.claude-plugin/marketplace.json":
    "claude-marketplace",
  "distribution/claude-marketplace/plugins/skillwire-autonomous-activation/.claude-plugin/plugin.json":
    "claude-release-plugin",
  "distribution/claude-marketplace/plugins/skillwire-autonomous-activation/skills/autonomous-skill-activation/SKILL.md":
    "claude-release-skill",
  "integrations/claude/skillwire-autonomous-activation/.claude-plugin/plugin.json":
    "claude-plugin",
  ...catalogFixtureFiles(),
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_value, index) => {
      const version = String(index + 1).padStart(3, "0");
      return [`migrations/${version}_fixture.sql`, `migration-${version}`];
    }),
  ),
};

export function releasePayloadMode(path: string): 0o644 | 0o755 {
  return path === "bin/skillwire" || path === "runtime/node" ? 0o755 : 0o644;
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Fixture numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported canonical JSON fixture value");
}

export function releaseManifestFixture(
  overrides: Partial<ReleaseManifest> = {},
): ReleaseManifest {
  const archiveSha256 = sha256(FIXTURE_ARCHIVE);
  const payload = Object.entries(RELEASE_PAYLOAD_FILES)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, contents]) => ({
      path,
      size: Buffer.byteLength(contents),
      sha256: sha256(contents),
      mode:
        releasePayloadMode(path) === 0o755
          ? ("0755" as const)
          : ("0644" as const),
    }));
  return {
    schemaVersion: "skillwire.release/v1",
    releaseVersion: "0.1.0-test.1",
    releaseSequence: 1,
    publishedAt: "2026-08-13T00:00:00.000Z",
    sourceCommit: "1".repeat(40),
    trustPolicySequence: 1,
    trustPolicy: {
      path: "skillwire-trust-policy-v1.json",
      size: Buffer.byteLength(canonicalJson(trustPolicyFixture())),
      sha256: sha256(canonicalJson(trustPolicyFixture())),
    },
    signatureBundles: [
      {
        signerId: "github-release-primary",
        path: "skillwire-0.1.0-test.1-linux-amd64.release.sigstore.json",
      },
    ],
    architecture: "amd64",
    archive: {
      path: "skillwire-0.1.0-test.1-linux-amd64.tar.zst",
      size: FIXTURE_ARCHIVE.byteLength,
      sha256: archiveSha256,
    },
    payload,
    images: [
      {
        role: "skillwire",
        repository: "ghcr.io/lucenx9/skillwire",
        digest: `sha256:${sha256("image")}`,
        platform: "linux/amd64",
      },
      {
        role: "postgres",
        repository: "docker.io/library/postgres",
        digest: `sha256:${sha256("postgres-image")}`,
        platform: "linux/amd64",
      },
    ],
    compatibility: {
      node: "24.18.0",
      postgresql: "17.10",
      schemaMinimum: 10,
      schemaMaximum: 10,
    },
    feature003Integrity: {
      path: "distribution/codex-marketplace/release-integrity.json",
      size: 9,
      sha256: sha256("integrity"),
    },
    components: deriveReleaseComponents(payload),
    ...overrides,
  };
}

export function trustedRootFixture(): Record<string, unknown> {
  return {
    mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    tlogs: [{ baseUrl: "https://rekor.sigstore.dev" }],
    certificateAuthorities: [{ uri: "https://fulcio.sigstore.dev" }],
  };
}

export function trustPolicyFixture(
  overrides: Partial<TrustPolicy> = {},
): TrustPolicy {
  return {
    schemaVersion: "skillwire.trust-policy/v1",
    sequence: 1,
    minimumReleaseSequence: 1,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z",
    trustedRoot: {
      path: "trusted-root.v1.json",
      sha256: sha256(canonicalJson(trustedRootFixture())),
      mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    },
    cosign: {
      version: "3.1.3",
      binaries: {
        amd64: sha256("cosign-amd64"),
        arm64: sha256("cosign-arm64"),
      },
    },
    signers: [
      {
        signerId: "github-release-primary",
        issuer: "https://token.actions.githubusercontent.com",
        repository: "Lucenx9/skillwire",
        workflow: ".github/workflows/self-hosted-release.yml",
        refPattern: "refs/tags/self-hosted-v*",
      },
    ],
    deniedSigners: [],
    deniedManifestDigests: [],
    overlap: { previousSequence: null, requiredSignerCount: 1 },
    ...overrides,
  };
}

export function bundleV03Fixture(
  manifest: ReleaseManifest,
): Record<string, unknown> {
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      certificate: {
        rawBytes: Buffer.from("fixture-certificate").toString("base64"),
      },
      tlogEntries: [
        {
          logIndex: "1",
          integratedTime: "1",
          logId: { keyId: Buffer.from("fixture-log-id").toString("base64") },
          inclusionPromise: {
            signedEntryTimestamp: Buffer.from("fixture-set").toString("base64"),
          },
        },
      ],
    },
    messageSignature: {
      messageDigest: {
        algorithm: "SHA2_256",
        digest: Buffer.from(sha256(canonicalJson(manifest)), "hex").toString(
          "base64",
        ),
      },
      signature: Buffer.from("fixture-signature").toString("base64"),
    },
  };
}
