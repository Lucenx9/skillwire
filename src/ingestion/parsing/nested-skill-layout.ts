import type { GitTreeEntry } from "../../domain/external-catalog/types.js";

export interface NestedSkillLayoutOptions {
  readonly maximumCandidates: number;
  readonly excludedRoots?: readonly string[] | undefined;
}

export function discoverNestedSkillDocuments(
  tree: readonly GitTreeEntry[],
  options: NestedSkillLayoutOptions,
  signal?: AbortSignal,
): readonly GitTreeEntry[] {
  signal?.throwIfAborted();
  const excluded = new Set(
    [
      ".git",
      "node_modules",
      "vendor",
      "fixture",
      "fixtures",
      "deprecated",
      ...(options.excludedRoots ?? []),
    ].map((value) => value.toLowerCase()),
  );
  const candidates = tree
    .filter((entry, index) => {
      if (index % 256 === 0) signal?.throwIfAborted();
      return (
        entry.type === "blob" &&
        entry.mode === "100644" &&
        entry.size !== undefined &&
        (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")) &&
        entry.path.split("/").every((segment) => {
          const normalized = segment.toLowerCase();
          return !segment.startsWith(".") && !excluded.has(normalized);
        })
      );
    })
    .toSorted((left, right) => left.path.localeCompare(right.path, "en-US"));
  if (candidates.length === 0) throw new Error("MANIFEST_INVALID");
  if (candidates.length > options.maximumCandidates)
    throw new Error("TREE_OVERSIZED");
  return candidates;
}
