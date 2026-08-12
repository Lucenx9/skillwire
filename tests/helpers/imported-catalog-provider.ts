import type { AsyncSkillCatalogProvider } from "../../src/application/ports/async-skill-catalog-provider.js";
import { sha256Hex } from "../../src/domain/catalog/canonical-revision.js";
import type {
  CatalogSkillMetadata,
  SkillRevision,
} from "../../src/domain/catalog/types.js";

const commitSha = "84fdeffd12f2ee307994d1eb6feb48173b6e0502";
const automaticId = "gh-1148788086-tdd-aaaaaaaa";
const userOnlyId = "gh-1148788086-ask-matt-bbbbbbbb";

function metadata(
  id: string,
  name: string,
  invocationMode: "automatic" | "user-only",
): CatalogSkillMetadata {
  return {
    id,
    name,
    description: `${name} imported acceptance skill`,
    capabilities: [name],
    revision: `gh-${"a".repeat(64)}`,
    trustAtPublication: "structurally-verified",
    currentAdvisoryStatus: "available",
    catalogOrigin: {
      kind: "github",
      owner: "mattpocock",
      repository: "skills",
      commitSha,
      skillPath: `skills/${name}/SKILL.md`,
      license: { spdxId: "MIT", attribution: "Matt Pocock" },
    },
    currentClassification: "verified",
    invocationMode,
  };
}

const entries = [
  metadata(automaticId, "tdd", "automatic"),
  metadata(userOnlyId, "ask-matt", "user-only"),
] as const;

function revision(entry: CatalogSkillMetadata): SkillRevision {
  const content = "# Reference\n\nImported text.\n";
  return {
    skillId: entry.id,
    revision: entry.revision,
    publishedProvenance: {
      source: {
        provider: "github",
        reference: `github:1148788086:${entry.catalogOrigin?.skillPath ?? ""}`,
      },
      sourceRevision: commitSha,
      owner: "Matt Pocock",
      license: "MIT",
      trustAtPublication: "structurally-verified",
    },
    instructions: `# ${entry.name}\n\nImported instructions.\n`,
    instructionsSha256: sha256Hex(
      `# ${entry.name}\n\nImported instructions.\n`,
    ),
    resourceManifest: [
      {
        path: "REFERENCE.md",
        mediaType: "text/markdown",
        byteLength: Buffer.byteLength(content),
        sha256: sha256Hex(content),
      },
    ],
    resources: [
      {
        path: "REFERENCE.md",
        mediaType: "text/markdown",
        byteLength: Buffer.byteLength(content),
        sha256: sha256Hex(content),
        content,
      },
    ],
    bundleSha256: "a".repeat(64),
    catalogOrigin: entry.catalogOrigin,
    currentClassification: "verified",
    invocationMode: entry.invocationMode,
    dependencies: [],
  };
}

export const importedCatalogFixture = {
  automaticId,
  userOnlyId,
  revision: entries[0].revision,
  provider: {
    listMetadata: () => Promise.resolve(entries),
    findRevision: (skillId: string, requestedRevision: string) => {
      const entry = entries.find(
        (candidate) =>
          candidate.id === skillId && candidate.revision === requestedRevision,
      );
      return Promise.resolve(entry === undefined ? undefined : revision(entry));
    },
    advisoryStatus: (skillId: string, requestedRevision: string) =>
      Promise.resolve(
        entries.some(
          (entry) =>
            entry.id === skillId && entry.revision === requestedRevision,
        )
          ? ("available" as const)
          : undefined,
      ),
  } satisfies AsyncSkillCatalogProvider,
};
