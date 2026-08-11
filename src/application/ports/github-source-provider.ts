import type {
  GitHubRepositoryCoordinate,
  GitHubRepositoryIdentity,
  GitHubRepositorySnapshot,
} from "../../domain/external-catalog/types.js";

export interface OperationContext {
  readonly signal?: AbortSignal | undefined;
  readonly deadline?: number | undefined;
}

export interface GitHubSourceProvider {
  resolvePublicRepository(
    coordinate: GitHubRepositoryCoordinate,
    context?: OperationContext,
  ): Promise<GitHubRepositoryIdentity>;
  readDefaultSnapshot(
    repository: GitHubRepositoryIdentity,
    context?: OperationContext,
  ): Promise<GitHubRepositorySnapshot>;
  readBlob(
    repository: GitHubRepositoryIdentity,
    sha: string,
    expectedSize: number,
    context?: OperationContext,
  ): Promise<Uint8Array>;
}
