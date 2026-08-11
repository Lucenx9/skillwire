import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

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
    join(PROJECT_ROOT, "catalog", "skills"),
    join(workspace, "catalog", "skills"),
    {
      recursive: true,
    },
  );
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
