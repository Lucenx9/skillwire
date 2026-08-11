import type {
  ExternalSkillRevision,
  GitHubRepositoryIdentity,
  ImportTraceResult,
} from "../../domain/external-catalog/types.js";
import type { OperationContext } from "./github-source-provider.js";

export interface SourceRegistration {
  readonly sourceId: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly created: boolean;
}

export interface PublishExternalSnapshotInput {
  readonly sourceId: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly manifestVersion: string;
  readonly revisions: readonly ExternalSkillRevision[];
}

export interface PublishedExternalSnapshot {
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly commitSha: string;
  readonly traces: readonly ImportTraceResult[];
  readonly created: boolean;
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
  publishSnapshot(
    input: PublishExternalSnapshotInput,
    context?: OperationContext,
  ): Promise<PublishedExternalSnapshot>;
}
