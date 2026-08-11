export type TrustAtPublication = "trusted";

export type CurrentAdvisoryStatus = "available" | "unavailable" | "revoked";

export interface CatalogSkillMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly revision: string;
  readonly trustAtPublication: TrustAtPublication;
  readonly currentAdvisoryStatus: CurrentAdvisoryStatus;
}

export interface RankedSkill {
  readonly skill: CatalogSkillMetadata;
  readonly score: number;
  readonly matchingCapabilities: readonly string[];
}

export interface SearchPreview {
  readonly rank: number;
  readonly skillId: string;
  readonly name: string;
  readonly summary: string;
  readonly matchingCapabilities: readonly string[];
  readonly trustAtPublication: TrustAtPublication;
  readonly currentAdvisoryStatus: CurrentAdvisoryStatus;
  readonly revision: string;
}

export interface SearchSkillsResult {
  readonly skills: readonly SearchPreview[];
}

export interface SourceReference {
  readonly provider: string;
  readonly reference: string;
}

export interface PublishedProvenance {
  readonly source: SourceReference;
  readonly sourceRevision: string;
  readonly owner: string;
  readonly license: "Apache-2.0";
  readonly trustAtPublication: TrustAtPublication;
}

export type TextMediaType = "text/markdown" | "text/plain";

export interface ResourceManifestEntry {
  readonly path: string;
  readonly mediaType: TextMediaType;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface VerifiedResource extends ResourceManifestEntry {
  readonly content: string;
}

export interface SkillRevision {
  readonly skillId: string;
  readonly revision: string;
  readonly publishedProvenance: PublishedProvenance;
  readonly instructions: string;
  readonly instructionsSha256: string;
  readonly resourceManifest: readonly ResourceManifestEntry[];
  readonly resources: readonly VerifiedResource[];
  readonly bundleSha256: string;
}

export interface CatalogReleaseRevision {
  readonly skillId: string;
  readonly revision: string;
  readonly bundleSha256: string;
  readonly recordPath: string;
}

export interface CatalogRelease {
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly genesis: true;
  readonly previousReleaseCommit: null;
  readonly inventorySha256: string;
  readonly revisionCount: 10;
  readonly revisions: readonly CatalogReleaseRevision[];
  readonly publishedAt: string;
}

export interface RevisionPublicationRecord {
  readonly schemaVersion: 1;
  readonly skillId: string;
  readonly revision: string;
  readonly bundleSha256: string;
  readonly publishedProvenance: PublishedProvenance;
  readonly instructionsSha256: string;
  readonly resourceManifest: readonly ResourceManifestEntry[];
  readonly sourcePaths: {
    readonly instructions: string;
    readonly provenance: string;
    readonly resources: readonly string[];
  };
}
