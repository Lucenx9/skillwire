export const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type CandidateClassification =
  "discovered" | "verified" | "quarantined" | "curated";
export type GitHubSyncRunState =
  | "queued"
  | "running"
  | "published"
  | "quarantined"
  | "failed"
  | "cancelled"
  | "superseded";
export type InvocationMode = "automatic" | "user-only";
export type ImportResult = "published" | "reused" | "quarantined";
export type TrustAtPublication = "structurally-verified";
export type ExternalAdvisoryStatus = "available" | "unavailable" | "revoked";
export type ValidationSeverity = "error" | "warning";
export type GitObjectMode =
  "100644" | "100755" | "040000" | "120000" | "160000";

export interface GitHubRepositoryCoordinate {
  readonly owner: string;
  readonly repository: string;
}

export interface GitHubRepositoryIdentity extends GitHubRepositoryCoordinate {
  readonly repositoryId: number;
  readonly defaultBranch: string;
}

export interface IngestionBudgets {
  readonly maximumRequests: number;
  readonly maximumPages: number;
  readonly maximumRetries: number;
  readonly maximumResponseBytes: number;
  readonly maximumTreeEntries: number;
  readonly maximumCandidates: number;
  readonly maximumResourcesPerSkill: number;
  readonly maximumTextBytes: number;
  readonly maximumBundleBytes: number;
  readonly maximumRepositoryBytes: number;
}

export const DEFAULT_INGESTION_BUDGETS: IngestionBudgets = Object.freeze({
  maximumRequests: 512,
  maximumPages: 10,
  maximumRetries: 3,
  maximumResponseBytes: 8 * 1024 * 1024,
  maximumTreeEntries: 20_000,
  maximumCandidates: 256,
  maximumResourcesPerSkill: 64,
  maximumTextBytes: 256 * 1024,
  maximumBundleBytes: 2 * 1024 * 1024,
  maximumRepositoryBytes: 32 * 1024 * 1024,
});

export interface GitTreeEntry {
  readonly path: string;
  readonly mode: GitObjectMode;
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string;
  readonly size?: number | undefined;
}

export interface GitHubRepositorySnapshot {
  readonly repository: GitHubRepositoryIdentity;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly tree: readonly GitTreeEntry[];
}

export interface ExternalResourceInput {
  readonly path: string;
  readonly mediaType: "text/markdown" | "text/plain";
  readonly content: string;
}

export interface ExternalDependencyInput {
  readonly skillName: string;
  readonly required: boolean;
  readonly evidenceKind: "manifest" | "frontmatter" | "explicit-invocation";
  readonly evidenceLocator: string;
}

export interface ExternalValidationFinding {
  readonly code: string;
  readonly severity: ValidationSeverity;
  readonly subjectKind:
    "source" | "snapshot" | "candidate" | "revision" | "resource";
  readonly subjectId: string;
}

export interface ExternalAdvisory {
  readonly revision: string;
  readonly sequence: number;
  readonly status: ExternalAdvisoryStatus;
  readonly reasonCode: string;
  readonly effectiveAt: string;
}

export interface ImportedSkillInput {
  readonly name: string;
  readonly description: string;
  readonly skillPath: string;
  readonly instructions: string;
  readonly invocationMode: InvocationMode;
  readonly resources: readonly ExternalResourceInput[];
  readonly dependencies: readonly ExternalDependencyInput[];
}

export interface ExternalPublishedProvenance {
  readonly provider: "github";
  readonly repositoryId: number;
  readonly owner: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly skillPath: string;
  readonly sourceOwner: string;
  readonly spdxLicenseId: string;
  readonly licenseText: string;
}

export interface ExternalResourceManifestEntry {
  readonly path: string;
  readonly mediaType: "text/markdown" | "text/plain";
  readonly byteLength: number;
  readonly sha256: string;
  readonly content: string;
}

export interface ExternalDependency {
  readonly skillName: string;
  readonly required: boolean;
  readonly evidenceKind: "manifest" | "frontmatter" | "explicit-invocation";
  readonly evidenceLocator: string;
}

export interface ExternalSkillRevision {
  readonly schemaVersion: 2;
  readonly trustAtPublication: TrustAtPublication;
  readonly skillId: string;
  readonly revision: string;
  readonly name: string;
  readonly description: string;
  readonly provenance: ExternalPublishedProvenance;
  readonly invocationMode: InvocationMode;
  readonly instructions: string;
  readonly instructionsSha256: string;
  readonly resources: readonly ExternalResourceManifestEntry[];
  readonly dependencies: readonly ExternalDependency[];
  readonly contentIdentitySha256: string;
  readonly bundleSha256: string;
  readonly canonicalBytes: string;
}

export interface ImportTraceResult {
  readonly skillPath: string;
  readonly skillName: string;
  readonly result: ImportResult;
  readonly revision: string;
  readonly bundleSha256: string;
}

export function assertGitSha(value: string): string {
  if (!GIT_SHA_PATTERN.test(value)) throw new Error("INVALID_GIT_SHA");
  return value;
}

export function assertGitHubCoordinate(
  coordinate: GitHubRepositoryCoordinate,
): GitHubRepositoryCoordinate {
  const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
  const repositoryPattern =
    /^(?!\.\.?$)[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$/;
  if (
    !ownerPattern.test(coordinate.owner) ||
    !repositoryPattern.test(coordinate.repository)
  ) {
    throw new Error("INVALID_GITHUB_COORDINATE");
  }
  return coordinate;
}
