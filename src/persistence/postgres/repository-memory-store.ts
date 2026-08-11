import type { Pool } from "pg";

import type {
  RecordUsageInput,
  RepositoryMemoryStore,
} from "../../application/ports/repository-memory-store.js";
import type {
  RepositoryMemoryScope,
  RepositoryUsageProjection,
  SkillOutcome,
  SkillUsageRecord,
} from "../../domain/repository-memory/types.js";

interface UsageRow {
  readonly skill_id: string;
  readonly revision: string;
  readonly bundle_sha256: string;
  readonly first_used_at: Date;
  readonly last_used_at: Date;
  readonly usage_count: number;
  readonly outcome: SkillOutcome | null;
}

export class PostgresRepositoryMemoryStore implements RepositoryMemoryStore {
  public constructor(private readonly pool: Pool) {}

  public async recordUsage(
    scope: RepositoryMemoryScope,
    input: RecordUsageInput,
  ): Promise<void> {
    const result = await this.pool.query(
      `
        INSERT INTO repository_skill_usage (
          account_id,
          repository_hash,
          skill_id,
          revision,
          bundle_sha256
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (account_id, repository_hash, skill_id, revision)
        DO UPDATE SET
          last_used_at = statement_timestamp(),
          usage_count = repository_skill_usage.usage_count + 1
        WHERE repository_skill_usage.bundle_sha256 = EXCLUDED.bundle_sha256
        RETURNING 1
      `,
      [
        scope.accountId,
        scope.repositoryHash,
        input.skillId,
        input.revision,
        input.revisionSha256,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Stored revision integrity does not match catalog");
    }
  }

  public async list(
    scope: RepositoryMemoryScope,
  ): Promise<readonly SkillUsageRecord[]> {
    const result = await this.pool.query<UsageRow>(
      `
        SELECT
          skill_id,
          revision,
          bundle_sha256,
          first_used_at,
          last_used_at,
          usage_count,
          outcome
        FROM repository_skill_usage
        WHERE account_id = $1 AND repository_hash = $2
        ORDER BY last_used_at DESC, skill_id, revision
        LIMIT 100
      `,
      [scope.accountId, scope.repositoryHash],
    );
    return result.rows.map((row) => ({
      skillId: row.skill_id,
      revision: row.revision,
      revisionSha256: row.bundle_sha256,
      firstUsedAt: row.first_used_at.toISOString(),
      lastUsedAt: row.last_used_at.toISOString(),
      usageCount: row.usage_count,
      ...(row.outcome === null ? {} : { outcome: row.outcome }),
    }));
  }

  public async rankingProjection(
    scope: RepositoryMemoryScope,
  ): Promise<readonly RepositoryUsageProjection[]> {
    const result = await this.pool.query<{
      skill_id: string;
      revision: string;
      outcome: SkillOutcome | null;
    }>(
      `
        SELECT skill_id, revision, outcome
        FROM repository_skill_usage
        WHERE account_id = $1 AND repository_hash = $2
        ORDER BY last_used_at DESC, skill_id, revision
        LIMIT 100
      `,
      [scope.accountId, scope.repositoryHash],
    );
    return result.rows.map((row) => ({
      skillId: row.skill_id,
      revision: row.revision,
      outcome: row.outcome,
    }));
  }

  public async replaceOutcome(
    scope: RepositoryMemoryScope,
    skillId: string,
    revision: string,
    outcome: SkillOutcome,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE repository_skill_usage
        SET outcome = $5
        WHERE account_id = $1
          AND repository_hash = $2
          AND skill_id = $3
          AND revision = $4
      `,
      [scope.accountId, scope.repositoryHash, skillId, revision, outcome],
    );
    return result.rowCount === 1;
  }

  public async forget(
    scope: RepositoryMemoryScope,
    requestId: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          WITH database_time AS (
            SELECT statement_timestamp() AS created_at
          ),
          deleted AS (
            DELETE FROM repository_skill_usage
            WHERE account_id = $1 AND repository_hash = $2
            RETURNING 1
          )
          INSERT INTO repository_erasure_audit (
            account_id,
            request_id,
            created_at,
            expires_at,
            operation_result,
            removed_record_count
          )
          SELECT
            $1,
            $3,
            database_time.created_at,
            database_time.created_at + interval '30 days',
            'forgotten',
            (SELECT count(*) FROM deleted)
          FROM database_time
        `,
        [scope.accountId, scope.repositoryHash, requestId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
