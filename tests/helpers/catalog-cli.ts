import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import {
  createAdvisoryEvent,
  parseAdvisoryChain,
  serializeAdvisoryChain,
} from "../../src/domain/catalog/advisory-chain.js";

export const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function createCatalogWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "skillwire-catalog-"));
  mkdirSync(join(workspace, "catalog"), { recursive: true });
  cpSync(
    join(PROJECT_ROOT, "catalog", "inventory.json"),
    join(workspace, "catalog", "inventory.json"),
    {
      recursive: true,
    },
  );
  cpSync(
    join(PROJECT_ROOT, "catalog", "advisories.jsonl"),
    join(workspace, "catalog", "advisories.jsonl"),
  );
  cpSync(
    join(PROJECT_ROOT, "catalog", "skills"),
    join(workspace, "catalog", "skills"),
    {
      recursive: true,
    },
  );
  return workspace;
}

export function createPublishedCatalogWithStatus(
  state: "unavailable" | "revoked",
): string {
  const workspace = mkdtempSync(join(tmpdir(), "skillwire-catalog-status-"));
  cpSync(join(PROJECT_ROOT, "catalog"), join(workspace, "catalog"), {
    recursive: true,
  });
  const advisoryPath = join(workspace, "catalog", "advisories.jsonl");
  const events = parseAdvisoryChain(readFileSync(advisoryPath, "utf8"));
  const previous = events.at(-1);
  if (previous === undefined)
    throw new Error("Expected genesis advisory event");
  const releasePath = join(
    workspace,
    "catalog/releases/launch-catalog-v1/release.json",
  );
  const release = JSON.parse(readFileSync(releasePath, "utf8")) as {
    advisoryChainHead: string;
    revisions: { skillId: string; revision: string; bundleSha256: string }[];
  };
  const target = release.revisions.find(
    (entry) => entry.skillId === "typescript-code-review",
  );
  if (target === undefined) throw new Error("Expected target revision");
  const event = createAdvisoryEvent({
    sequence: previous.sequence + 1,
    previousEventHash: previous.eventHash,
    advisoryId: `typescript-code-review-${state}`,
    skillId: target.skillId,
    revision: target.revision,
    revisionSha256: target.bundleSha256,
    kind: state === "revoked" ? "security" : "availability",
    state,
    reasonCode: state === "revoked" ? "SECURITY_REVOKED" : "SOURCE_UNAVAILABLE",
    effectiveAt: "2026-08-11T12:00:00.000Z",
  });
  writeFileSync(advisoryPath, serializeAdvisoryChain([...events, event]));
  release.advisoryChainHead = event.eventHash;
  writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  return workspace;
}

export function runCatalogCommand(
  workspace: string,
  command: "publish" | "verify",
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      join(PROJECT_ROOT, "src", "catalog", "admin-cli.ts"),
      command,
      "--release-id",
      "launch-catalog-v1",
      ...(command === "publish" ? ["--genesis"] : []),
    ],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, SKILLWIRE_ROOT: workspace },
      encoding: "utf8",
    },
  );
}
