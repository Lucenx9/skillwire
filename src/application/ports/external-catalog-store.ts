import type {
  CandidateClassification,
  CandidateTraceResult,
  ClassificationActor,
  ExternalCandidateInput,
  ExternalSkillRevision,
  GitHubRepositoryIdentity,
  ImportTraceResult,
} from "../../domain/external-catalog/types.js";
import type { OperationContext } from "./github-source-provider.js";
import type { SyncLease } from "./sync-lease-store.js";

export interface SourceRegistration {
  readonly sourceId: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly created: boolean;
  readonly metadataEtag?: string | undefined;
  readonly metadataCacheSha256?: string | undefined;
}

export interface ObservedSourceMetadataCache {
  readonly etag: string;
  readonly bodySha256: string;
}

export interface PublishExternalSnapshotInput {
  readonly sourceId: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly manifestVersion: string;
  readonly revisions: readonly ExternalSkillRevision[];
  readonly adapterKind?: "claude-plugin" | "nested-skill" | undefined;
  readonly candidates?: readonly ExternalCandidateInput[] | undefined;
  readonly validationInputSha256?: string | undefined;
  readonly lease?: SyncLease | undefined;
  readonly observedRepository?: GitHubRepositoryIdentity | undefined;
  readonly observedMetadataCache?:
    ObservedSourceMetadataCache | null | undefined;
  readonly expectedAdvisoryChainHead?: string | undefined;
  readonly reverifyCandidateId?: string | undefined;
}

export interface PublishedExternalSnapshot {
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly resourceCount: number;
  readonly traces: readonly ImportTraceResult[];
  readonly candidateTraces: readonly CandidateTraceResult[];
  readonly created: boolean;
}

export interface AdministrativeCandidate {
  readonly candidateId: string;
  readonly sourceId: string;
  readonly classification: CandidateClassification;
  readonly reasonCodes: readonly string[];
  readonly revision?: string | undefined;
}

export interface AdministrativeCandidatePage {
  readonly items: readonly AdministrativeCandidate[];
  readonly nextCursor: string | null;
}

export interface AdministrativeSource {
  readonly sourceId: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly classification: CandidateClassification;
  readonly registered: boolean;
}

export interface ClassificationChange {
  readonly candidateId: string;
  readonly classification: CandidateClassification;
  readonly changed: boolean;
}

export interface ExternalCatalogStore {
  registerSource(
    repository: GitHubRepositoryIdentity,
    registeredBy: string,
    context?: OperationContext,
  ): Promise<SourceRegistration>;
  listSources(
    context?: OperationContext,
  ): Promise<readonly SourceRegistration[]>;
  listAdministrativeSources(
    classification?: CandidateClassification,
    context?: OperationContext,
    sourceId?: string,
  ): Promise<readonly AdministrativeSource[]>;
  publishSnapshot(
    input: PublishExternalSnapshotInput,
    context?: OperationContext,
  ): Promise<PublishedExternalSnapshot>;
  refreshSourceIdentity(
    sourceId: string,
    repository: GitHubRepositoryIdentity,
    context?: OperationContext,
  ): Promise<void>;
  listAdministrativeCandidates(
    classification?: CandidateClassification,
    context?: OperationContext,
  ): Promise<readonly AdministrativeCandidate[]>;
  listAdministrativeCandidatesPage(
    options: {
      readonly classification?: CandidateClassification | undefined;
      readonly sourceId?: string | undefined;
      readonly cursor?: string | undefined;
      readonly limit: number;
    },
    context?: OperationContext,
  ): Promise<AdministrativeCandidatePage>;
  transitionCandidate(
    candidateId: string,
    next: CandidateClassification,
    actor: ClassificationActor,
    actorId: string,
    reasonCode: string,
    context?: OperationContext,
  ): Promise<ClassificationChange>;
  recordSourceUnavailable(
    sourceId: string,
    observation?: {
      readonly authenticated: boolean;
      readonly uncached: boolean;
      readonly repositoryId: number;
    },
    lease?: SyncLease,
    context?: OperationContext,
  ): Promise<boolean>;
  advisoryChainHead(context?: OperationContext): Promise<string>;
}
