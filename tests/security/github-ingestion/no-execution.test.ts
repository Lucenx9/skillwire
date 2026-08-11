import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat().filter((path) => path.endsWith(".ts"));
}

describe("GitHub ingestion execution boundary", () => {
  it("contains no clone, checkout, process execution, or repository materialization primitive", async () => {
    const roots = [
      join(process.cwd(), "src/ingestion"),
      join(process.cwd(), "src/application/services"),
      join(process.cwd(), "src/persistence/postgres"),
    ];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const sources = await Promise.all(
      files.map((path) => readFile(path, "utf8")),
    );
    const joined = sources.join("\n");
    for (const forbidden of [
      /node:child_process/,
      /\bexecFile(?:Sync)?\s*\(/,
      /\bspawn(?:Sync)?\s*\(/,
      /\bgit\s+(?:clone|checkout|switch)\b/,
      /node:vm/,
      /node:worker_threads/,
      /writeFile\s*\(/,
      /createWriteStream\s*\(/,
    ]) {
      expect(joined).not.toMatch(forbidden);
    }
  });
});
