import type {
  GitHubRepositoryCoordinate,
  GitHubRepositoryIdentity,
  GitHubRepositorySnapshot,
} from "../../domain/external-catalog/types.js";

export interface OperationContext {
  readonly signal?: AbortSignal | undefined;
  readonly deadline?: number | undefined;
  readonly budget?: GitHubOperationBudget | undefined;
}

export interface GitHubOperationBudget {
  requests: number;
  retries: number;
  responseBytes: number;
  readonly maximumRequests: number;
  readonly maximumRetries: number;
  readonly maximumResponseBytes: number;
}

export interface ConditionalRepositoryResult {
  readonly repository?: GitHubRepositoryIdentity | undefined;
  readonly etag?: string | undefined;
  readonly notModified: boolean;
}

export interface GitHubSourceProvider {
  readonly authenticated?: boolean | undefined;
  resolvePublicRepository(
    coordinate: GitHubRepositoryCoordinate,
    context?: OperationContext,
  ): Promise<GitHubRepositoryIdentity>;
  resolvePublicRepositoryConditionally?(
    coordinate: GitHubRepositoryCoordinate,
    etag: string | undefined,
    context?: OperationContext,
  ): Promise<ConditionalRepositoryResult>;
  readDefaultSnapshot(
    repository: GitHubRepositoryIdentity,
    context?: OperationContext,
  ): Promise<GitHubRepositorySnapshot>;
  readSnapshotAtCommit?(
    repository: GitHubRepositoryIdentity,
    commitSha: string,
    context?: OperationContext,
  ): Promise<GitHubRepositorySnapshot>;
  readBlob(
    repository: GitHubRepositoryIdentity,
    sha: string,
    expectedSize: number,
    context?: OperationContext,
  ): Promise<Uint8Array>;
}
