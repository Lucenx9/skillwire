import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

export async function snapshotTree(root: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = `${directory}/${entry.name}`;
      hash.update(absolutePath.slice(root.length));
      if (entry.isDirectory()) await visit(absolutePath);
      else hash.update(await readFile(absolutePath));
    }
  }

  await visit(root);
  return hash.digest("hex");
}
