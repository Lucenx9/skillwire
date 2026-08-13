import { createHash } from "node:crypto";

import type { ReleaseComponents, ReleaseManifest } from "./release-manifest.js";

type Payload = ReleaseManifest["payload"];

function aggregate(entries: Payload): string {
  if (entries.length === 0)
    throw new Error("Release component inventory is empty");
  const lines = entries
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map(
      ({ path, size, sha256, mode }) =>
        `${path}\t${String(size)}\t${sha256}\t${mode}\n`,
    )
    .join("");
  return createHash("sha256").update(lines).digest("hex");
}

function entriesBelow(payload: Payload, prefixes: readonly string[]): Payload {
  return payload.filter(({ path }) =>
    prefixes.some((prefix) => path.startsWith(prefix)),
  );
}

export function deriveReleaseComponents(payload: Payload): ReleaseComponents {
  const compose = payload.find(
    ({ path }) => path === "distribution/self-hosted/compose.yaml",
  );
  if (compose === undefined)
    throw new Error("Production Compose identity is missing");
  const migrations = payload.filter(({ path }) =>
    /^migrations\/\d{3}_[a-z0-9_]+\.sql$/.test(path),
  );
  const versions = migrations.map(({ path }) =>
    path.slice("migrations/".length, "migrations/".length + 3),
  );
  const expectedVersions = Array.from({ length: 10 }, (_value, index) =>
    String(index + 1).padStart(3, "0"),
  );
  if (versions.join("\0") !== expectedVersions.join("\0")) {
    throw new Error("Release migration set must bind exact migrations 001-010");
  }
  const catalogEntries = entriesBelow(payload, ["catalog/"]);
  const advisory = payload.find(
    ({ path }) => path === "catalog/advisories.jsonl",
  );
  const revisions = payload.filter(({ path }) =>
    /^catalog\/releases\/[^/]+\/revisions\/[^/]+\.json$/.test(path),
  );
  if (advisory === undefined || revisions.length !== 10) {
    throw new Error(
      "Release catalog must bind its advisory head and ten first-party revisions",
    );
  }
  const codexEntries = entriesBelow(payload, [
    "integrations/codex/",
    "distribution/codex-marketplace/",
    "distribution/codex-release-marketplace/",
  ]);
  const claudeEntries = entriesBelow(payload, [
    "integrations/claude/",
    "distribution/claude-marketplace/",
  ]);
  return {
    compose: {
      path: compose.path,
      size: compose.size,
      sha256: compose.sha256,
    },
    migrations: {
      sha256: aggregate(migrations),
      count: 10,
      latest: "010",
      forwardOnly: ["010"],
    },
    catalog: {
      sha256: aggregate(catalogEntries),
      advisorySha256: advisory.sha256,
      firstPartyRevisionCount: 10,
    },
    adapters: {
      codexSha256: aggregate(codexEntries),
      claudeSha256: aggregate(claudeEntries),
    },
  };
}
