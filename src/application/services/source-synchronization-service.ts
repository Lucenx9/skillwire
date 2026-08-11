import { posix } from "node:path";

import type {
  ExternalCatalogStore,
  ObservedSourceMetadataCache,
  PublishedExternalSnapshot,
  SourceRegistration,
} from "../ports/external-catalog-store.js";
import type {
  GitHubOperationBudget,
  GitHubSourceProvider,
  OperationContext,
} from "../ports/github-source-provider.js";
import type { SyncLease } from "../ports/sync-lease-store.js";
import { sha256Hex } from "../../domain/catalog/canonical-revision.js";
import { createExternalSkillRevision } from "../../domain/external-catalog/canonical-revision-v2.js";
import {
  dependencyCycleMembers,
  resolveInternalDependencies,
} from "../../domain/external-catalog/dependency-resolver.js";
import {
  detectAttribution,
  detectSpdxLicense,
  validatePinnedLicense,
} from "../../domain/external-catalog/license-validator.js";
import {
  DEFAULT_INGESTION_BUDGETS,
  type ExternalCandidateInput,
  type ExternalDependencyInput,
  type ExternalResourceInput,
  type ExternalValidationFinding,
  type GitHubRepositoryIdentity,
  type GitTreeEntry,
  type ImportedSkillInput,
  type IngestionBudgets,
} from "../../domain/external-catalog/types.js";
import { ExternalRevisionPublisher } from "../../ingestion/external-revision-publisher.js";
import { parseClaudePluginManifest } from "../../ingestion/parsing/claude-plugin-manifest.js";
import {
  parseSkillDocument,
  type ParsedSkillDocument,
} from "../../ingestion/parsing/frontmatter.js";
import { extractTextualResourceReferences } from "../../ingestion/parsing/markdown-resources.js";
import { discoverNestedSkillDocuments } from "../../ingestion/parsing/nested-skill-layout.js";

interface StagedCandidate {
  readonly root: string;
  readonly skillPath: string;
  document?: ParsedSkillDocument;
  resources: ExternalResourceInput[];
  dependencies: ExternalDependencyInput[];
  findings: ExternalValidationFinding[];
}

const LICENSE_NAMES = new Set([
  "license",
  "license.md",
  "license.txt",
  "copying",
]);

function requiredBlob(
  tree: readonly GitTreeEntry[],
  path: string,
  maximumBytes: number,
): GitTreeEntry {
  const entry = tree.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error("RESOURCE_MISSING");
  if (
    entry.type !== "blob" ||
    entry.mode !== "100644" ||
    entry.size === undefined
  ) {
    throw new Error("OBJECT_UNSUPPORTED");
  }
  if (entry.size > maximumBytes) throw new Error("RESOURCE_OVERSIZED");
  return entry;
}

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\u0000")) throw new Error("RESOURCE_NON_TEXT");
  return text.replaceAll("\r\n", "\n").normalize("NFC");
}

function publicSkillId(
  repositoryId: number,
  name: string,
  skillPath: string,
): string {
  const safeName =
    name.replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "") || "skill";
  return `gh-${String(repositoryId)}-${safeName}-${sha256Hex(skillPath).slice(0, 8)}`.slice(
    0,
    80,
  );
}

export class SourceSynchronizationService {
  readonly #publisher: ExternalRevisionPublisher;

  constructor(
    private readonly provider: GitHubSourceProvider,
    private readonly store: ExternalCatalogStore,
    private readonly budgets: IngestionBudgets = DEFAULT_INGESTION_BUDGETS,
  ) {
    this.#publisher = new ExternalRevisionPublisher(store);
  }

  async sync(
    sourceId: string,
    context?: OperationContext,
  ): Promise<PublishedExternalSnapshot> {
    return this.#sync(sourceId, undefined, context);
  }

  async syncScheduled(
    sourceId: string,
    lease: SyncLease,
    context?: OperationContext,
  ): Promise<void> {
    await this.#sync(sourceId, lease, context);
  }

  syncWithLease(
    sourceId: string,
    lease: SyncLease,
    context?: OperationContext,
  ): Promise<PublishedExternalSnapshot> {
    return this.#sync(sourceId, lease, context);
  }

  async #sync(
    sourceId: string,
    lease: SyncLease | undefined,
    context: OperationContext = {},
  ): Promise<PublishedExternalSnapshot> {
    if (lease !== undefined && lease.key !== `sync/${sourceId}`) {
      throw new Error("LEASE_SCOPE_INVALID");
    }
    const source = (await this.store.listSources(context)).find(
      (candidate) => candidate.sourceId === sourceId,
    );
    if (source === undefined) throw new Error("SOURCE_NOT_FOUND");
    const budget: GitHubOperationBudget = context.budget ?? {
      requests: 0,
      retries: 0,
      responseBytes: 0,
      maximumRequests: this.budgets.maximumRequests,
      maximumRetries: this.budgets.maximumRetries,
      maximumResponseBytes: this.budgets.maximumResponseBytes,
    };
    const operation: OperationContext = {
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
      budget,
    };
    operation.signal?.throwIfAborted();
    let canonicalRepository;
    let observedMetadataCache: ObservedSourceMetadataCache | null | undefined;
    try {
      if (this.provider.resolvePublicRepositoryConditionally === undefined) {
        canonicalRepository = await this.provider.resolvePublicRepository(
          source.repository,
          operation,
        );
      } else {
        const conditional =
          await this.provider.resolvePublicRepositoryConditionally(
            source.repository,
            source.metadataEtag,
            operation,
          );
        if (conditional.notModified) {
          if (
            source.metadataEtag === undefined ||
            source.metadataCacheSha256 !==
              repositoryMetadataHash(source.repository)
          ) {
            throw new Error("CACHE_MISS_ON_NOT_MODIFIED");
          }
          canonicalRepository = source.repository;
          observedMetadataCache = {
            etag: source.metadataEtag,
            bodySha256: source.metadataCacheSha256,
          };
        } else {
          if (conditional.repository === undefined) {
            throw new Error("GITHUB_SCHEMA_INVALID");
          }
          canonicalRepository = conditional.repository;
          observedMetadataCache =
            conditional.etag === undefined
              ? null
              : {
                  etag: conditional.etag,
                  bodySha256: repositoryMetadataHash(conditional.repository),
                };
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "GITHUB_HTTP_404" ||
          error.message === "SOURCE_NOT_PUBLIC")
      ) {
        await this.store.recordSourceUnavailable(sourceId, lease, operation);
      }
      throw error;
    }
    if (canonicalRepository.repositoryId !== source.repository.repositoryId) {
      throw new Error("SOURCE_IDENTITY_MISMATCH");
    }
    return this.#syncSource(
      { ...source, repository: canonicalRepository },
      lease,
      operation,
      observedMetadataCache,
    );
  }

  async #syncSource(
    source: SourceRegistration,
    lease: SyncLease | undefined,
    context: OperationContext,
    observedMetadataCache: ObservedSourceMetadataCache | null | undefined,
  ): Promise<PublishedExternalSnapshot> {
    const snapshot = await this.provider.readDefaultSnapshot(
      source.repository,
      context,
    );
    context.signal?.throwIfAborted();
    const manifestTreeEntry = snapshot.tree.find(
      ({ path }) => path === ".claude-plugin/plugin.json",
    );
    let adapterKind: "claude-plugin" | "nested-skill";
    let manifestVersion: string;
    let declaredLicense: string | undefined;
    let declaredAttribution: string | undefined;
    let skillEntries: readonly GitTreeEntry[];
    if (manifestTreeEntry !== undefined) {
      adapterKind = "claude-plugin";
      const manifestEntry = requiredBlob(
        snapshot.tree,
        manifestTreeEntry.path,
        this.budgets.maximumTextBytes,
      );
      const manifest = parseClaudePluginManifest(
        await this.provider.readBlob(
          source.repository,
          manifestEntry.sha,
          manifestEntry.size ?? 0,
          context,
        ),
      );
      manifestVersion = manifest.version;
      declaredLicense = manifest.license;
      declaredAttribution = manifest.author;
      skillEntries = manifest.skillRoots.map((root) =>
        requiredBlob(
          snapshot.tree,
          posix.join(root, "SKILL.md"),
          this.budgets.maximumTextBytes,
        ),
      );
    } else {
      adapterKind = "nested-skill";
      manifestVersion = "nested-v1";
      skillEntries = discoverNestedSkillDocuments(snapshot.tree, {
        maximumCandidates: this.budgets.maximumCandidates,
      });
    }
    if (skillEntries.length > this.budgets.maximumCandidates) {
      throw new Error("TREE_OVERSIZED");
    }

    let decodedRepositoryBytes = 0;
    const readText = async (entry: GitTreeEntry): Promise<string> => {
      context.signal?.throwIfAborted();
      if (
        entry.size === undefined ||
        entry.size > this.budgets.maximumTextBytes
      ) {
        throw new Error("RESOURCE_OVERSIZED");
      }
      decodedRepositoryBytes += entry.size;
      if (decodedRepositoryBytes > this.budgets.maximumRepositoryBytes) {
        throw new Error("RESPONSE_BUDGET_EXCEEDED");
      }
      return decodeText(
        await this.provider.readBlob(
          source.repository,
          entry.sha,
          entry.size,
          context,
        ),
      );
    };

    const licenseEntries = snapshot.tree.filter(
      (entry) =>
        !entry.path.includes("/") &&
        LICENSE_NAMES.has(entry.path.toLowerCase()),
    );
    let licenseFailure: ExternalValidationFinding | undefined;
    let licenseText = "";
    let spdxLicenseId = "";
    let attribution = declaredAttribution ?? "";
    try {
      if (licenseEntries.length === 0) throw new Error("LICENSE_MISSING");
      const licenseTexts = [];
      for (const entry of licenseEntries) {
        licenseTexts.push(
          await readText(
            requiredBlob(
              snapshot.tree,
              entry.path,
              this.budgets.maximumTextBytes,
            ),
          ),
        );
      }
      if (new Set(licenseTexts).size > 1) throw new Error("LICENSE_CONFLICT");
      licenseText = licenseTexts[0] ?? "";
      const validated = validatePinnedLicense({
        declaredSpdxId: declaredLicense,
        detectedSpdxId: detectSpdxLicense(licenseText),
        licenseText,
        attribution:
          attribution.length > 0
            ? attribution
            : (detectAttribution(licenseText) ?? ""),
      });
      spdxLicenseId = validated.spdxId;
      attribution = validated.attribution;
    } catch (error) {
      licenseFailure = findingFromError(error, "source-license", "candidate");
    }

    const staged: StagedCandidate[] = [];
    for (const entry of skillEntries) {
      context.signal?.throwIfAborted();
      const root = entry.path.replace(/\/SKILL\.md$/, "");
      const candidate: StagedCandidate = {
        root,
        skillPath: entry.path,
        resources: [],
        dependencies: [],
        findings: licenseFailure === undefined ? [] : [licenseFailure],
      };
      try {
        candidate.document = parseSkillDocument(
          new TextEncoder().encode(await readText(entry)),
        );
      } catch (error) {
        candidate.findings.push(
          findingFromError(error, entry.path, "candidate"),
        );
      }
      staged.push(candidate);
    }

    const duplicateNames = new Set<string>();
    const nameCounts = new Map<string, number>();
    for (const candidate of staged) {
      if (candidate.document !== undefined) {
        const name = candidate.document.name;
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
    }
    for (const [name, count] of nameCounts)
      if (count > 1) duplicateNames.add(name);
    const names = staged.flatMap(({ document }) =>
      document === undefined ? [] : [document.name],
    );
    for (const candidate of staged) {
      const document = candidate.document;
      if (document === undefined) continue;
      if (duplicateNames.has(document.name)) {
        candidate.findings.push({
          code: "SKILL_DUPLICATE_IDENTITY",
          severity: "error",
          subjectKind: "candidate",
          subjectId: document.name,
        });
      }
      const resolution = resolveInternalDependencies(
        names,
        document.name,
        document.dependencyEvidence,
      );
      candidate.dependencies = [...resolution.dependencies];
      candidate.findings.push(...resolution.findings);
      try {
        const references = extractTextualResourceReferences(
          document.instructions,
          candidate.skillPath,
        );
        if (references.length > this.budgets.maximumResourcesPerSkill) {
          throw new Error("RESOURCE_OVERSIZED");
        }
        for (const reference of references) {
          const resourceEntry = requiredBlob(
            snapshot.tree,
            reference.repositoryPath,
            this.budgets.maximumTextBytes,
          );
          candidate.resources.push({
            path: reference.manifestPath,
            mediaType: reference.mediaType,
            content: await readText(resourceEntry),
          });
        }
      } catch (error) {
        candidate.findings.push(
          findingFromError(error, candidate.skillPath, "resource"),
        );
      }
    }

    const graph = new Map(
      staged.flatMap((candidate) =>
        candidate.document === undefined
          ? []
          : [[candidate.document.name, candidate.dependencies] as const],
      ),
    );
    for (const name of dependencyCycleMembers(graph)) {
      staged
        .find(({ document }) => document?.name === name)
        ?.findings.push({
          code: "DEPENDENCY_CYCLE",
          severity: "error",
          subjectKind: "candidate",
          subjectId: name,
        });
    }

    let propagated = true;
    while (propagated) {
      propagated = false;
      for (const candidate of staged) {
        if (candidate.document === undefined || candidate.findings.length > 0)
          continue;
        const unavailableTarget = candidate.dependencies.find((dependency) => {
          const target = staged.find(
            ({ document }) => document?.name === dependency.skillName,
          );
          return target === undefined || target.findings.length > 0;
        });
        if (unavailableTarget !== undefined) {
          candidate.findings.push({
            code: "DEPENDENCY_MISSING",
            severity: "error",
            subjectKind: "candidate",
            subjectId: `${candidate.document.name}:${unavailableTarget.skillName}`,
          });
          propagated = true;
        }
      }
    }

    const eligibleByName = new Map(
      staged.flatMap((candidate) =>
        candidate.document === undefined || candidate.findings.length > 0
          ? []
          : [[candidate.document.name, candidate] as const],
      ),
    );
    const revisionsByName = new Map<
      string,
      ReturnType<typeof createExternalSkillRevision>
    >();
    const buildRevision = (
      candidate: StagedCandidate,
    ): ReturnType<typeof createExternalSkillRevision> => {
      const document = candidate.document;
      if (document === undefined) throw new Error("SKILL_SCHEMA_INVALID");
      const existing = revisionsByName.get(document.name);
      if (existing !== undefined) return existing;
      const dependencies = candidate.dependencies.map((dependency) => {
        const target = eligibleByName.get(dependency.skillName);
        if (target === undefined) throw new Error("DEPENDENCY_MISSING");
        const targetRevision = buildRevision(target);
        return {
          ...dependency,
          targetSkillId: targetRevision.skillId,
          targetRevision: targetRevision.revision,
        };
      });
      const skill: ImportedSkillInput = {
        name: document.name,
        description: document.description,
        skillPath: candidate.skillPath,
        instructions: document.instructions,
        invocationMode: document.invocationMode,
        resources: candidate.resources,
        dependencies,
      };
      const revision = createExternalSkillRevision({
        skillId: publicSkillId(
          source.repository.repositoryId,
          document.name,
          candidate.skillPath,
        ),
        provenance: {
          provider: "github",
          repositoryId: source.repository.repositoryId,
          owner: source.repository.owner,
          repository: source.repository.repository,
          commitSha: snapshot.commitSha,
          skillPath: candidate.skillPath,
          sourceOwner: attribution,
          spdxLicenseId,
          licenseText,
        },
        skill,
      });
      revisionsByName.set(document.name, revision);
      return revision;
    };

    const candidates: ExternalCandidateInput[] = staged.map((candidate) => {
      const document = candidate.document;
      const name =
        document?.name ??
        `invalid-${sha256Hex(candidate.skillPath).slice(0, 12)}`;
      const description =
        document?.description ?? "Candidate failed structural validation.";
      if (document === undefined || candidate.findings.length > 0) {
        return {
          skillPath: candidate.skillPath,
          name,
          description,
          adapterKind,
          classification: "quarantined",
          findings:
            candidate.findings.length === 0
              ? [
                  findingFromError(
                    new Error("SKILL_SCHEMA_INVALID"),
                    candidate.skillPath,
                    "candidate",
                  ),
                ]
              : candidate.findings,
        };
      }
      const revision = buildRevision(candidate);
      return {
        skillPath: candidate.skillPath,
        name,
        description,
        adapterKind,
        classification: "verified",
        findings: [],
        revision,
      };
    });
    const revisions = candidates.flatMap(({ revision }) =>
      revision === undefined ? [] : [revision],
    );
    return this.#publisher.publish(
      {
        sourceId: source.sourceId,
        commitSha: snapshot.commitSha,
        treeSha: snapshot.treeSha,
        manifestVersion,
        adapterKind,
        revisions,
        candidates,
        observedRepository: source.repository,
        ...(observedMetadataCache === undefined
          ? {}
          : { observedMetadataCache }),
        ...(lease === undefined ? {} : { lease }),
      },
      context,
    );
  }
}

function repositoryMetadataHash(repository: GitHubRepositoryIdentity): string {
  return sha256Hex(
    JSON.stringify({
      repositoryId: repository.repositoryId,
      owner: repository.owner,
      repository: repository.repository,
      defaultBranch: repository.defaultBranch,
    }),
  );
}

function findingFromError(
  error: unknown,
  subjectId: string,
  subjectKind: ExternalValidationFinding["subjectKind"],
): ExternalValidationFinding {
  const message =
    error instanceof Error ? error.message : "SKILL_SCHEMA_INVALID";
  const mapping = new Map<string, ExternalValidationFinding["code"]>([
    ["MANIFEST_INVALID", "MANIFEST_INVALID"],
    ["MANIFEST_DUPLICATE_SKILL", "MANIFEST_DUPLICATE_SKILL"],
    ["SKILL_SCHEMA_INVALID", "SKILL_SCHEMA_INVALID"],
    ["SKILL_OVERSIZED", "RESOURCE_OVERSIZED"],
    ["SKILL_NON_TEXT", "RESOURCE_NON_TEXT"],
    ["SKILL_DUPLICATE_IDENTITY", "SKILL_DUPLICATE_IDENTITY"],
    ["OBJECT_UNSUPPORTED", "OBJECT_UNSUPPORTED"],
    ["PATH_UNSAFE", "PATH_UNSAFE"],
    ["RESOURCE_MISSING", "RESOURCE_MISSING"],
    ["RESOURCE_NON_TEXT", "RESOURCE_NON_TEXT"],
    ["RESOURCE_OVERSIZED", "RESOURCE_OVERSIZED"],
    ["LICENSE_MISSING", "LICENSE_MISSING"],
    ["LICENSE_UNSUPPORTED", "LICENSE_UNSUPPORTED"],
    ["LICENSE_CONFLICT", "LICENSE_CONFLICT"],
    ["ATTRIBUTION_MISSING", "ATTRIBUTION_MISSING"],
    ["HASH_MISMATCH", "HASH_MISMATCH"],
  ]);
  return {
    code: mapping.get(message) ?? "SKILL_SCHEMA_INVALID",
    severity: "error",
    subjectKind,
    subjectId,
  };
}
