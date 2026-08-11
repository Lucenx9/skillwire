import type { GitTreeEntry } from "../../domain/external-catalog/types.js";

export interface NestedSkillLayoutOptions {
  readonly maximumCandidates: number;
  readonly excludedRoots?: readonly string[] | undefined;
}

export function discoverNestedSkillDocuments(
  tree: readonly GitTreeEntry[],
  options: NestedSkillLayoutOptions,
): readonly GitTreeEntry[] {
  const excluded = new Set(
    (options.excludedRoots ?? [".git", "node_modules", "vendor"]).map((value) =>
      value.toLowerCase(),
    ),
  );
  const candidates = tree
    .filter(
      (entry) =>
        entry.type === "blob" &&
        entry.mode === "100644" &&
        entry.size !== undefined &&
        (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")) &&
        !excluded.has(entry.path.split("/")[0]?.toLowerCase() ?? ""),
    )
    .toSorted((left, right) => left.path.localeCompare(right.path, "en-US"));
  if (candidates.length === 0) throw new Error("MANIFEST_INVALID");
  if (candidates.length > options.maximumCandidates)
    throw new Error("TREE_OVERSIZED");
  return candidates;
}
