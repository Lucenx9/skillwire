import type {
  GitHubSourceProvider,
  OperationContext,
} from "../../application/ports/github-source-provider.js";
import {
  DEFAULT_INGESTION_BUDGETS,
  type GitHubRepositoryCoordinate,
  type GitHubRepositoryIdentity,
  type GitHubRepositorySnapshot,
} from "../../domain/external-catalog/types.js";
import type { GitHubRestClient } from "./rest-client.js";

export class GitHubCommitTreeBlobReader implements GitHubSourceProvider {
  constructor(
    private readonly client: GitHubRestClient,
    private readonly maximumTreeEntries = DEFAULT_INGESTION_BUDGETS.maximumTreeEntries,
  ) {}

  resolvePublicRepository(
    coordinate: GitHubRepositoryCoordinate,
    context?: OperationContext,
  ): Promise<GitHubRepositoryIdentity> {
    return this.client.resolvePublicRepository(coordinate, context);
  }

  async readDefaultSnapshot(
    repository: GitHubRepositoryIdentity,
    context?: OperationContext,
  ): Promise<GitHubRepositorySnapshot> {
    const commitSha = await this.client.resolveDefaultRef(repository, context);
    const treeSha = await this.client.readCommit(
      repository,
      commitSha,
      context,
    );
    const tree = await this.client.readTree(
      repository,
      treeSha,
      this.maximumTreeEntries,
      context,
    );
    return { repository, commitSha, treeSha, tree };
  }

  readBlob(
    repository: GitHubRepositoryIdentity,
    sha: string,
    expectedSize: number,
    context?: OperationContext,
  ): Promise<Uint8Array> {
    return this.client.readBlob(repository, sha, expectedSize, context);
  }
}
