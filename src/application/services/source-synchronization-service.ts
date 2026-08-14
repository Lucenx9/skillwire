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
import { inspectClaudePluginManifest } from "../../ingestion/parsing/claude-plugin-manifest.js";
import {
  parseSkillDocument,
  type ParsedSkillDocument,
} from "../../ingestion/parsing/frontmatter.js";
import { extractTextualResourceReferences } from "../../ingestion/parsing/markdown-resources.js";
import { discoverNestedSkillDocuments } from "../../ingestion/parsing/nested-skill-layout.js";
import { decodeInertText } from "../../ingestion/parsing/text-content.js";

interface StagedCandidate {
  readonly root: string;
  readonly skillPath: string;
  document?: ParsedSkillDocument;
  resources: ExternalResourceInput[];
  dependencies: ExternalDependencyInput[];
  findings: ExternalValidationFinding[];
  legal?: {
    readonly spdxLicenseId: string;
    readonly licenseText: string;
    readonly attribution: string;
    readonly licenseEvidencePath: string;
    readonly licenseBlobSha: string;
    readonly skillDeclaredSpdxId?: string | undefined;
    readonly noticeText?: string | undefined;
    readonly noticeEvidencePath?: string | undefined;
    readonly noticeBlobSha?: string | undefined;
  };
}

interface SkillDeclaration {
  readonly root: string;
  readonly skillPath: string;
  readonly entry?: GitTreeEntry | undefined;
  readonly findings: readonly ExternalValidationFinding[];
}

const LICENSE_NAMES = new Set([
  "license",
  "license.md",
  "license.txt",
  "copying",
]);
const NOTICE_NAMES = new Set(["notice", "notice.md", "notice.txt"]);

export function requiredBlob(
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
  return decodeInertText(bytes);
}

export function publicSkillId(
  repositoryId: number,
  name: string,
  skillPath: string,
): string {
  const safeName =
    name
      .normalize("NFKC")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/(^-|-$)/g, "") || "skill";
  const prefix = `gh-${String(repositoryId)}-`;
  const suffix = `-${sha256Hex(skillPath.normalize("NFC")).slice(0, 16)}`;
  const readableLength = 80 - prefix.length - suffix.length;
  if (readableLength < 1) throw new Error("PUBLICATION_CONFLICT");
  const readable = safeName.slice(0, readableLength).replace(/-+$/u, "") || "s";
  return `${prefix}${readable}${suffix}`;
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
    requestedCommitSha?: string,
    requestedRepository?: {
      readonly repositoryId: number;
      readonly owner: string;
      readonly repository: string;
    },
    requestedCandidateId?: string,
  ): Promise<PublishedExternalSnapshot> {
    return this.#sync(
      sourceId,
      lease,
      context,
      requestedCommitSha,
      requestedRepository,
      requestedCandidateId,
    );
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
    requestedCommitSha?: string,
    requestedRepository?: {
      readonly repositoryId: number;
      readonly owner: string;
      readonly repository: string;
    },
    requestedCandidateId?: string,
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
    const signals: AbortSignal[] = [];
    if (context.signal !== undefined) signals.push(context.signal);
    if (context.deadline !== undefined) {
      if (context.deadline <= Date.now()) {
        throw new DOMException("deadline exceeded", "TimeoutError");
      }
      signals.push(
        AbortSignal.timeout(Math.max(1, context.deadline - Date.now())),
      );
    }
    const signal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals);
    const operation: OperationContext = {
      ...(signal === undefined ? {} : { signal }),
      ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
      budget,
    };
    operation.signal?.throwIfAborted();
    let canonicalRepository;
    let observedMetadataCache: ObservedSourceMetadataCache | null | undefined;
    if (requestedCommitSha !== undefined) {
      if (
        requestedRepository?.repositoryId !== source.repository.repositoryId
      ) {
        throw new Error("SOURCE_IDENTITY_MISMATCH");
      }
      canonicalRepository = {
        ...requestedRepository,
        defaultBranch: source.repository.defaultBranch,
      };
      return this.#syncSource(
        { ...source, repository: canonicalRepository },
        lease,
        operation,
        undefined,
        requestedCommitSha,
        requestedCandidateId,
      );
    }
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
        if (this.provider.authenticated === true) {
          try {
            await this.provider.resolvePublicRepository(
              source.repository,
              operation,
            );
          } catch (confirmationError) {
            if (
              confirmationError instanceof Error &&
              (confirmationError.message === "GITHUB_HTTP_404" ||
                confirmationError.message === "SOURCE_NOT_PUBLIC")
            ) {
              await this.store.recordSourceUnavailable(
                sourceId,
                {
                  authenticated: true,
                  uncached: true,
                  repositoryId: source.repository.repositoryId,
                },
                lease,
                operation,
              );
            }
          }
        }
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
      undefined,
      undefined,
    );
  }

  async #syncSource(
    source: SourceRegistration,
    lease: SyncLease | undefined,
    context: OperationContext,
    observedMetadataCache: ObservedSourceMetadataCache | null | undefined,
    requestedCommitSha: string | undefined,
    requestedCandidateId: string | undefined,
  ): Promise<PublishedExternalSnapshot> {
    const expectedAdvisoryChainHead =
      await this.store.advisoryChainHead(context);
    const snapshot =
      requestedCommitSha === undefined
        ? await this.provider.readDefaultSnapshot(source.repository, context)
        : this.provider.readSnapshotAtCommit === undefined
          ? (() => {
              throw new Error("EXACT_COMMIT_READ_UNSUPPORTED");
            })()
          : await this.provider.readSnapshotAtCommit(
              source.repository,
              requestedCommitSha,
              context,
            );
    context.signal?.throwIfAborted();
    const manifestTreeEntry = snapshot.tree.find(
      ({ path }) => path === ".claude-plugin/plugin.json",
    );
    let adapterKind: "claude-plugin" | "nested-skill" = "nested-skill";
    let manifestVersion = "nested-v1";
    let declaredLicense: string | undefined;
    let declaredAttribution: string | undefined;
    let skillDeclarations: readonly SkillDeclaration[] = [];
    let useNestedLayout = manifestTreeEntry === undefined;
    if (manifestTreeEntry !== undefined) {
      adapterKind = "claude-plugin";
      try {
        const manifestEntry = requiredBlob(
          snapshot.tree,
          manifestTreeEntry.path,
          this.budgets.maximumTextBytes,
        );
        const inspected = inspectClaudePluginManifest(
          await this.provider.readBlob(
            source.repository,
            manifestEntry.sha,
            manifestEntry.size ?? 0,
            context,
          ),
          context.signal,
        );
        if (inspected.kind === "metadata-only") {
          useNestedLayout = true;
        } else {
          const { manifest } = inspected;
          manifestVersion = manifest.version;
          declaredLicense = manifest.license;
          declaredAttribution = manifest.author;
          skillDeclarations = manifest.skillRoots.map((root) => {
            const skillPath = posix.join(root, "SKILL.md");
            try {
              return {
                root,
                skillPath,
                entry: requiredBlob(
                  snapshot.tree,
                  skillPath,
                  this.budgets.maximumTextBytes,
                ),
                findings: [],
              };
            } catch (error) {
              return {
                root,
                skillPath,
                findings: [findingFromError(error, skillPath, "candidate")],
              };
            }
          });
        }
      } catch (error) {
        rethrowCancellation(error, context);
        const finding = findingFromError(error, "manifest", "snapshot");
        const locator = sha256Hex(
          `${snapshot.commitSha}:${finding.code}:manifest`,
        ).slice(0, 16);
        return this.#publisher.publish(
          {
            sourceId: source.sourceId,
            commitSha: snapshot.commitSha,
            treeSha: snapshot.treeSha,
            manifestVersion: "invalid-v1",
            adapterKind,
            revisions: [],
            candidates: [
              {
                skillPath: `_invalid/${locator}/SKILL.md`,
                name: `invalid-${locator}`,
                description:
                  "Repository manifest failed deterministic validation.",
                adapterKind,
                classification: "quarantined",
                findings: [finding],
              },
            ],
            ...(requestedCommitSha === undefined
              ? { observedRepository: source.repository }
              : {}),
            ...(observedMetadataCache === undefined
              ? {}
              : { observedMetadataCache }),
            ...(lease === undefined ? {} : { lease }),
            expectedAdvisoryChainHead,
            ...(requestedCandidateId === undefined
              ? {}
              : { reverifyCandidateId: requestedCandidateId }),
          },
          context,
        );
      }
    }
    if (useNestedLayout) {
      adapterKind = "nested-skill";
      manifestVersion = "nested-v1";
      try {
        skillDeclarations = discoverNestedSkillDocuments(
          snapshot.tree,
          {
            maximumCandidates: this.budgets.maximumCandidates,
          },
          context.signal,
        ).map((entry) => ({
          root: entry.path === "SKILL.md" ? "." : posix.dirname(entry.path),
          skillPath: entry.path,
          entry,
          findings: [],
        }));
      } catch (error) {
        rethrowCancellation(error, context);
        const finding = findingFromError(error, "layout", "snapshot");
        const locator = sha256Hex(
          `${snapshot.commitSha}:${finding.code}:layout`,
        ).slice(0, 16);
        return this.#publisher.publish(
          {
            sourceId: source.sourceId,
            commitSha: snapshot.commitSha,
            treeSha: snapshot.treeSha,
            manifestVersion,
            adapterKind,
            revisions: [],
            candidates: [
              {
                skillPath: `_invalid/${locator}/SKILL.md`,
                name: `invalid-${locator}`,
                description:
                  "Repository layout failed deterministic validation.",
                adapterKind,
                classification: "quarantined",
                findings: [finding],
              },
            ],
            ...(requestedCommitSha === undefined
              ? { observedRepository: source.repository }
              : {}),
            ...(observedMetadataCache === undefined
              ? {}
              : { observedMetadataCache }),
            ...(lease === undefined ? {} : { lease }),
            expectedAdvisoryChainHead,
            ...(requestedCandidateId === undefined
              ? {}
              : { reverifyCandidateId: requestedCandidateId }),
          },
          context,
        );
      }
    }
    if (skillDeclarations.length > this.budgets.maximumCandidates) {
      const finding = findingFromError(
        new Error("TREE_OVERSIZED"),
        "candidate-budget",
        "snapshot",
      );
      const locator = sha256Hex(
        `${snapshot.commitSha}:${finding.code}:candidate-budget`,
      ).slice(0, 16);
      return this.#publisher.publish(
        {
          sourceId: source.sourceId,
          commitSha: snapshot.commitSha,
          treeSha: snapshot.treeSha,
          manifestVersion,
          adapterKind,
          revisions: [],
          candidates: [
            {
              skillPath: `_invalid/${locator}/SKILL.md`,
              name: `invalid-${locator}`,
              description: "Repository candidate budget was exceeded.",
              adapterKind,
              classification: "quarantined",
              findings: [finding],
            },
          ],
          ...(requestedCommitSha === undefined
            ? { observedRepository: source.repository }
            : {}),
          ...(observedMetadataCache === undefined
            ? {}
            : { observedMetadataCache }),
          ...(lease === undefined ? {} : { lease }),
          expectedAdvisoryChainHead,
          ...(requestedCandidateId === undefined
            ? {}
            : { reverifyCandidateId: requestedCandidateId }),
        },
        context,
      );
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

    const licenseEntries = snapshot.tree
      .filter(
        (entry) =>
          !entry.path.includes("/") &&
          LICENSE_NAMES.has(entry.path.toLowerCase()),
      )
      .toSorted((left, right) => left.path.localeCompare(right.path, "en-US"));
    const noticeEntries = snapshot.tree
      .filter(
        (entry) =>
          !entry.path.includes("/") &&
          NOTICE_NAMES.has(entry.path.toLowerCase()),
      )
      .toSorted((left, right) => left.path.localeCompare(right.path, "en-US"));
    let licenseFailure: ExternalValidationFinding | undefined;
    let licenseText = "";
    let spdxLicenseId = "";
    let attribution = declaredAttribution ?? "";
    let licenseEvidencePath = "";
    let licenseBlobSha = "";
    let noticeText: string | undefined;
    let noticeEvidencePath: string | undefined;
    let noticeBlobSha: string | undefined;
    try {
      if (licenseEntries.length === 0) throw new Error("LICENSE_MISSING");
      const licenseTexts: string[] = [];
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
      const licenseEntry = licenseEntries[0];
      if (licenseEntry === undefined) throw new Error("LICENSE_MISSING");
      licenseEvidencePath = licenseEntry.path;
      licenseBlobSha = licenseEntry.sha;
      if (noticeEntries.length > 0) {
        const noticeTexts: string[] = [];
        for (const entry of noticeEntries) {
          noticeTexts.push(
            await readText(
              requiredBlob(
                snapshot.tree,
                entry.path,
                this.budgets.maximumTextBytes,
              ),
            ),
          );
        }
        if (new Set(noticeTexts).size > 1) throw new Error("LICENSE_CONFLICT");
        const noticeEntry = noticeEntries[0];
        noticeText = noticeTexts[0];
        noticeEvidencePath = noticeEntry?.path;
        noticeBlobSha = noticeEntry?.sha;
      }
      const detectedAttribution = detectAttribution(licenseText);
      if (
        attribution.length > 0 &&
        detectedAttribution !== undefined &&
        attribution.normalize("NFKC").toLocaleLowerCase("en-US") !==
          detectedAttribution.normalize("NFKC").toLocaleLowerCase("en-US")
      ) {
        throw new Error("LICENSE_CONFLICT");
      }
      const validated = validatePinnedLicense({
        declaredSpdxId: declaredLicense,
        detectedSpdxId: detectSpdxLicense(licenseText),
        licenseText,
        attribution:
          attribution.length > 0
            ? attribution
            : (detectAttribution(licenseText) ?? ""),
        ...(noticeText === undefined ? {} : { noticeText }),
      });
      spdxLicenseId = validated.spdxId;
      attribution = validated.attribution;
    } catch (error) {
      rethrowCancellation(error, context);
      licenseFailure = findingFromError(error, "source-license", "candidate");
    }

    const staged: StagedCandidate[] = [];
    for (const declaration of skillDeclarations) {
      context.signal?.throwIfAborted();
      const entry = declaration.entry;
      const candidate: StagedCandidate = {
        root: declaration.root,
        skillPath: declaration.skillPath,
        resources: [],
        dependencies: [],
        findings: [
          ...declaration.findings,
          ...(licenseFailure === undefined ? [] : [licenseFailure]),
        ],
        ...(licenseFailure !== undefined
          ? {}
          : {
              legal: {
                spdxLicenseId,
                licenseText,
                attribution,
                licenseEvidencePath,
                licenseBlobSha,
                ...(noticeText === undefined ? {} : { noticeText }),
                ...(noticeEvidencePath === undefined
                  ? {}
                  : { noticeEvidencePath }),
                ...(noticeBlobSha === undefined ? {} : { noticeBlobSha }),
              },
            }),
      };
      if (entry === undefined) {
        staged.push(candidate);
        continue;
      }
      try {
        candidate.document = parseSkillDocument(
          new TextEncoder().encode(await readText(entry)),
          context.signal,
        );
        const directory = posix.dirname(candidate.skillPath);
        const skillNoticeEntries = snapshot.tree
          .filter(
            (treeEntry) =>
              posix.dirname(treeEntry.path) === directory &&
              NOTICE_NAMES.has(posix.basename(treeEntry.path).toLowerCase()),
          )
          .toSorted((left, right) =>
            left.path.localeCompare(right.path, "en-US"),
          );
        if (skillNoticeEntries.length > 0 && candidate.legal !== undefined) {
          const skillNoticeTexts: string[] = [];
          for (const skillNoticeEntry of skillNoticeEntries) {
            skillNoticeTexts.push(
              await readText(
                requiredBlob(
                  snapshot.tree,
                  skillNoticeEntry.path,
                  this.budgets.maximumTextBytes,
                ),
              ),
            );
          }
          if (new Set(skillNoticeTexts).size > 1) {
            throw new Error("LICENSE_CONFLICT");
          }
          const skillNoticeEntry = skillNoticeEntries[0];
          if (skillNoticeEntry === undefined)
            throw new Error("LICENSE_CONFLICT");
          candidate.legal = {
            ...candidate.legal,
            noticeText: skillNoticeTexts[0] ?? "",
            noticeEvidencePath: skillNoticeEntry.path,
            noticeBlobSha: skillNoticeEntry.sha,
          };
        }
        const declaredSkillLicense = candidate.document.declaredSpdxId;
        if (declaredSkillLicense !== undefined) {
          const skillLicenseEntries = snapshot.tree
            .filter(
              (treeEntry) =>
                posix.dirname(treeEntry.path) === directory &&
                LICENSE_NAMES.has(posix.basename(treeEntry.path).toLowerCase()),
            )
            .toSorted((left, right) =>
              left.path.localeCompare(right.path, "en-US"),
            );
          if (declaredSkillLicense !== spdxLicenseId) {
            if (skillLicenseEntries.length === 0)
              throw new Error("LICENSE_CONFLICT");
            const skillLicenseEntry = skillLicenseEntries[0];
            if (skillLicenseEntry === undefined)
              throw new Error("LICENSE_CONFLICT");
            const skillLicenseText = await readText(
              requiredBlob(
                snapshot.tree,
                skillLicenseEntry.path,
                this.budgets.maximumTextBytes,
              ),
            );
            const skillLicense = validatePinnedLicense({
              declaredSpdxId: declaredSkillLicense,
              detectedSpdxId: detectSpdxLicense(skillLicenseText),
              licenseText: skillLicenseText,
              attribution: detectAttribution(skillLicenseText) ?? "",
              ...(candidate.legal?.noticeText === undefined
                ? {}
                : { noticeText: candidate.legal.noticeText }),
            });
            candidate.legal = {
              spdxLicenseId: skillLicense.spdxId,
              licenseText: skillLicense.licenseText,
              attribution: skillLicense.attribution,
              licenseEvidencePath: skillLicenseEntry.path,
              licenseBlobSha: skillLicenseEntry.sha,
              skillDeclaredSpdxId: declaredSkillLicense,
              ...(candidate.legal?.noticeText === undefined
                ? {}
                : { noticeText: candidate.legal.noticeText }),
              ...(candidate.legal?.noticeEvidencePath === undefined
                ? {}
                : {
                    noticeEvidencePath: candidate.legal.noticeEvidencePath,
                  }),
              ...(candidate.legal?.noticeBlobSha === undefined
                ? {}
                : { noticeBlobSha: candidate.legal.noticeBlobSha }),
            };
          } else if (candidate.legal !== undefined) {
            candidate.legal = {
              ...candidate.legal,
              skillDeclaredSpdxId: declaredSkillLicense,
            };
          }
        }
      } catch (error) {
        rethrowCancellation(error, context);
        candidate.findings.push(
          findingFromError(error, declaration.skillPath, "candidate"),
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
      if (
        candidate.dependencies.length > this.budgets.maximumDependenciesPerSkill
      ) {
        candidate.findings.push({
          code: "DEPENDENCY_AMBIGUOUS",
          severity: "error",
          subjectKind: "candidate",
          subjectId: candidate.skillPath,
        });
      }
      try {
        const references = extractTextualResourceReferences(
          document.instructions,
          candidate.skillPath,
          context.signal,
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
        const bundleBytes =
          Buffer.byteLength(document.instructions, "utf8") +
          candidate.resources.reduce(
            (total, resource) =>
              total + Buffer.byteLength(resource.content, "utf8"),
            0,
          ) +
          Buffer.byteLength(candidate.legal?.licenseText ?? "", "utf8") +
          Buffer.byteLength(candidate.legal?.noticeText ?? "", "utf8");
        if (bundleBytes > this.budgets.maximumBundleBytes) {
          throw new Error("RESOURCE_OVERSIZED");
        }
      } catch (error) {
        rethrowCancellation(error, context);
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
      if (document === undefined || candidate.legal === undefined)
        throw new Error("SKILL_SCHEMA_INVALID");
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
          sourceOwner: candidate.legal.attribution,
          spdxLicenseId: candidate.legal.spdxLicenseId,
          licenseText: candidate.legal.licenseText,
          licenseEvidencePath: candidate.legal.licenseEvidencePath,
          licenseBlobSha: candidate.legal.licenseBlobSha,
          ...(candidate.legal.skillDeclaredSpdxId === undefined
            ? {}
            : {
                skillDeclaredSpdxId: candidate.legal.skillDeclaredSpdxId,
              }),
          ...(candidate.legal.noticeText === undefined
            ? {}
            : { noticeText: candidate.legal.noticeText }),
          ...(candidate.legal.noticeEvidencePath === undefined
            ? {}
            : { noticeEvidencePath: candidate.legal.noticeEvidencePath }),
          ...(candidate.legal.noticeBlobSha === undefined
            ? {}
            : { noticeBlobSha: candidate.legal.noticeBlobSha }),
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
      try {
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
      } catch (error) {
        rethrowCancellation(error, context);
        return {
          skillPath: candidate.skillPath,
          name,
          description,
          adapterKind,
          classification: "quarantined",
          findings: [findingFromError(error, candidate.skillPath, "candidate")],
        };
      }
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
        ...(requestedCommitSha === undefined
          ? { observedRepository: source.repository }
          : {}),
        ...(observedMetadataCache === undefined
          ? {}
          : { observedMetadataCache }),
        ...(lease === undefined ? {} : { lease }),
        expectedAdvisoryChainHead,
        ...(requestedCandidateId === undefined
          ? {}
          : { reverifyCandidateId: requestedCandidateId }),
      },
      context,
    );
  }
}

function rethrowCancellation(error: unknown, context: OperationContext): void {
  if (context.signal?.aborted === true) {
    throw context.signal.reason instanceof Error
      ? context.signal.reason
      : new DOMException("operation cancelled", "AbortError");
  }
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    throw error;
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
    ["MANIFEST_OVERSIZED", "MANIFEST_INVALID"],
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
    ["DEPENDENCY_AMBIGUOUS", "DEPENDENCY_AMBIGUOUS"],
    ["TREE_TRUNCATED", "TREE_TRUNCATED"],
    ["TREE_OVERSIZED", "TREE_OVERSIZED"],
    ["TREE_AMBIGUOUS", "TREE_AMBIGUOUS"],
    ["RESPONSE_BUDGET_EXCEEDED", "RESOURCE_OVERSIZED"],
    ["BUNDLE_OVERSIZED", "RESOURCE_OVERSIZED"],
    ["TEXT_OVERSIZED", "RESOURCE_OVERSIZED"],
  ]);
  return {
    code: mapping.get(message) ?? "SKILL_SCHEMA_INVALID",
    severity: "error",
    subjectKind,
    subjectId,
  };
}
