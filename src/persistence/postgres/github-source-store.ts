import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  ExternalCatalogStore,
  SourceRegistration,
} from "../../application/ports/external-catalog-store.js";
import type { OperationContext } from "../../application/ports/github-source-provider.js";
import type { GitHubRepositoryIdentity } from "../../domain/external-catalog/types.js";
import { requestTransaction } from "./request-transaction.js";

interface SourceRow {
  readonly id: string;
  readonly github_repository_id: string;
  readonly owner: string;
  readonly repository: string;
  readonly default_branch: string;
}

export class PostgresGitHubSourceStore implements Pick<
  ExternalCatalogStore,
  "registerSource" | "listSources"
> {
  constructor(private readonly pool: Pool) {}

  async registerSource(
    repository: GitHubRepositoryIdentity,
    registeredBy: string,
    context: OperationContext = {},
  ): Promise<SourceRegistration> {
    return requestTransaction(this.pool, context, (client) =>
      this.#registerSource(client, repository, registeredBy),
    );
  }

  async #registerSource(
    client: PoolClient,
    repository: GitHubRepositoryIdentity,
    registeredBy: string,
  ): Promise<SourceRegistration> {
    const id = randomUUID();
    const result = await client.query<SourceRow>(
      `
        INSERT INTO github_sources (
          id, github_repository_id, owner, repository,
          normalized_owner, normalized_repository, default_branch
        ) VALUES ($1, $2, $3, $4, lower($3), lower($4), $5)
        ON CONFLICT (github_repository_id) DO UPDATE SET
          owner = EXCLUDED.owner,
          repository = EXCLUDED.repository,
          normalized_owner = EXCLUDED.normalized_owner,
          normalized_repository = EXCLUDED.normalized_repository,
          default_branch = EXCLUDED.default_branch,
          last_observed_at = statement_timestamp()
        RETURNING id, github_repository_id, owner, repository, default_branch, (xmax = 0) AS created
      `,
      [
        id,
        repository.repositoryId,
        repository.owner,
        repository.repository,
        repository.defaultBranch,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("SOURCE_REGISTRATION_FAILED");
    await client.query(
      `
        INSERT INTO github_source_aliases (
          normalized_owner, normalized_repository, source_id
        ) VALUES (lower($1), lower($2), $3)
        ON CONFLICT (normalized_owner, normalized_repository) DO UPDATE SET
          last_observed_at = statement_timestamp()
        WHERE github_source_aliases.source_id = EXCLUDED.source_id
      `,
      [repository.owner, repository.repository, row.id],
    );
    const registration = await client.query(
      `
        INSERT INTO github_source_registrations (source_id, registered_by)
        VALUES ($1, $2)
        ON CONFLICT (source_id) DO NOTHING
      `,
      [row.id, registeredBy],
    );
    return {
      sourceId: row.id,
      repository: {
        repositoryId: Number(row.github_repository_id),
        owner: row.owner,
        repository: row.repository,
        defaultBranch: row.default_branch,
      },
      created: registration.rowCount === 1,
    };
  }

  listSources(
    context: OperationContext = {},
  ): Promise<readonly SourceRegistration[]> {
    return requestTransaction(this.pool, context, async (client) => {
      const result = await client.query<SourceRow>(
        `
          SELECT id, github_repository_id, owner, repository, default_branch
          FROM github_sources
          ORDER BY normalized_owner, normalized_repository
          LIMIT 100
        `,
      );
      return result.rows.map((row) => ({
        sourceId: row.id,
        repository: {
          repositoryId: Number(row.github_repository_id),
          owner: row.owner,
          repository: row.repository,
          defaultBranch: row.default_branch,
        },
        created: false,
      }));
    });
  }
}
