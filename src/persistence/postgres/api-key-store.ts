import type { Pool } from "pg";

import type {
  ApiKeyStore,
  StoredApiKey,
} from "../../application/ports/api-key-store.js";
import {
  apiKeyDigest,
  type ParsedApiKeyToken,
} from "../../authentication/api-key-token.js";
import type { RequestExecution } from "../../application/request-execution.js";
import { requestTransaction } from "./request-transaction.js";

interface ApiKeyRow {
  readonly id: string;
  readonly account_id: string;
  readonly secret_digest: Buffer;
}

export class PostgresApiKeyStore implements ApiKeyStore {
  public constructor(
    private readonly pool: Pool,
    private readonly pepper: string,
  ) {}

  public async findActiveByPublicId(
    publicId: string,
    execution: RequestExecution = {},
  ): Promise<StoredApiKey | undefined> {
    return requestTransaction(this.pool, execution, async (client) => {
      const result = await client.query<ApiKeyRow>(
        `
        SELECT k.id, k.account_id, k.secret_digest
        FROM api_keys AS k
        JOIN accounts AS a ON a.id = k.account_id
        WHERE k.public_id = $1
          AND a.status = 'active'
          AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > statement_timestamp())
      `,
        [publicId],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            id: row.id,
            accountId: row.account_id,
            secretDigest: row.secret_digest,
          };
    });
  }

  public async markUsed(
    keyId: string,
    execution: RequestExecution = {},
  ): Promise<void> {
    await requestTransaction(this.pool, execution, async (client) => {
      await client.query(
        "UPDATE api_keys SET last_used_at = statement_timestamp() WHERE id = $1",
        [keyId],
      );
    });
  }

  public async createAccount(accountId: string): Promise<void> {
    await this.pool.query("INSERT INTO accounts (id) VALUES ($1)", [accountId]);
  }

  public async createKey(
    keyId: string,
    accountId: string,
    key: ParsedApiKeyToken,
    expiresAt?: Date,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO api_keys (
          id, account_id, public_id, secret_digest, expires_at
        ) VALUES ($1, $2, $3, $4, $5)
      `,
      [
        keyId,
        accountId,
        key.publicId,
        apiKeyDigest(key, this.pepper),
        expiresAt ?? null,
      ],
    );
  }

  public async revokeKey(keyId: string): Promise<void> {
    await this.pool.query(
      "UPDATE api_keys SET revoked_at = statement_timestamp() WHERE id = $1",
      [keyId],
    );
  }

  public async disableAccount(accountId: string): Promise<void> {
    await this.pool.query(
      "UPDATE accounts SET status = 'disabled' WHERE id = $1",
      [accountId],
    );
  }
}
