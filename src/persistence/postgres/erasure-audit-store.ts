import type { Pool } from "pg";

import type {
  ErasureAuditRecord,
  ErasureAuditStore,
} from "../../application/ports/erasure-audit-store.js";

interface AuditRow {
  readonly account_id: string;
  readonly request_id: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly operation_result: "forgotten";
  readonly removed_record_count: number;
}

export class PostgresErasureAuditStore implements ErasureAuditStore {
  public constructor(private readonly pool: Pool) {}

  public async listActive(
    accountId: string,
  ): Promise<readonly ErasureAuditRecord[]> {
    const result = await this.pool.query<AuditRow>(
      `
        SELECT
          account_id,
          request_id,
          created_at,
          expires_at,
          operation_result,
          removed_record_count
        FROM repository_erasure_audit
        WHERE account_id = $1
          AND expires_at > statement_timestamp()
        ORDER BY created_at DESC, request_id
        LIMIT 100
      `,
      [accountId],
    );
    return result.rows.map((row) => ({
      accountId: row.account_id,
      requestId: row.request_id,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      operationResult: row.operation_result,
      removedRecordCount: row.removed_record_count,
    }));
  }

  public async deleteExpired(): Promise<number> {
    const result = await this.pool.query(
      `
        DELETE FROM repository_erasure_audit
        WHERE expires_at <= statement_timestamp()
      `,
    );
    return result.rowCount ?? 0;
  }
}
