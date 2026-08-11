import { randomUUID } from "node:crypto";

import { createApiKeyToken } from "./api-key-token.js";
import { readRequiredConfiguration } from "../config.js";
import { PostgresApiKeyStore } from "../persistence/postgres/api-key-store.js";
import { createPostgresPool } from "../persistence/postgres/client.js";
import { runMigrations } from "../persistence/postgres/migration-runner.js";

type Command =
  "account:create" | "key:create" | "key:revoke" | "account:disable";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (
    command !== "account:create" &&
    command !== "key:create" &&
    command !== "key:revoke" &&
    command !== "account:disable"
  ) {
    throw new Error(
      "Expected account:create, key:create, key:revoke, or account:disable",
    );
  }
  const connectionString = readRequiredConfiguration(
    process.env,
    "DATABASE_URL",
  );
  const pepper = readRequiredConfiguration(
    process.env,
    "SKILLWIRE_API_KEY_PEPPER",
  );
  if (Buffer.byteLength(pepper) < 32) {
    throw new Error("SKILLWIRE_API_KEY_PEPPER must contain at least 32 bytes");
  }

  const pool = createPostgresPool(connectionString);
  try {
    await runMigrations(pool);
    const store = new PostgresApiKeyStore(pool, pepper);
    if (command === "account:create") {
      const accountId = randomUUID();
      await store.createAccount(accountId);
      process.stdout.write(`${JSON.stringify({ accountId })}\n`);
      return;
    }

    const accountId = argument("--account-id");
    const keyId = argument("--key-id");
    if (command === "key:create") {
      if (accountId === undefined) throw new Error("--account-id is required");
      const key = createApiKeyToken();
      const createdKeyId = randomUUID();
      await store.createKey(createdKeyId, accountId, key);
      process.stdout.write(
        `${JSON.stringify({ accountId, keyId: createdKeyId, token: key.token })}\n`,
      );
      return;
    }
    if (command === "key:revoke") {
      if (keyId === undefined) throw new Error("--key-id is required");
      await store.revokeKey(keyId);
      process.stdout.write(`${JSON.stringify({ revoked: true })}\n`);
      return;
    }
    if (accountId === undefined) throw new Error("--account-id is required");
    await store.disableAccount(accountId);
    process.stdout.write(`${JSON.stringify({ disabled: true })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Authentication administration failed"}\n`,
  );
  process.exitCode = 1;
});
