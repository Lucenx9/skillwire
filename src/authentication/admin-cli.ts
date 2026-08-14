import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createApiKeyToken } from "./api-key-token.js";
import {
  readDatabaseConfiguration,
  readRequiredConfiguration,
} from "../config.js";
import { PostgresApiKeyStore } from "../persistence/postgres/api-key-store.js";
import { createPostgresPool } from "../persistence/postgres/client.js";
import { runMigrations } from "../persistence/postgres/migration-runner.js";
import { redactText } from "../onboarding/cli/output.js";

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
  const connectionString = readDatabaseConfiguration(process.env);
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
      const tokenFileDescriptor = argument("--token-fd");
      const tokenOutput = argument("--token-output");
      const createdKeyId = argument("--key-id");
      if (
        createdKeyId === undefined ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          createdKeyId,
        )
      ) {
        throw new Error("--key-id must be a version-4 UUID");
      }
      if ((tokenFileDescriptor === undefined) === (tokenOutput === undefined)) {
        throw new Error(
          "key:create requires exactly one of --token-fd or --token-output",
        );
      }
      const key = createApiKeyToken();
      if (tokenFileDescriptor !== undefined) {
        if (!/^\d+$/.test(tokenFileDescriptor)) {
          throw new Error("--token-fd must be an integer");
        }
        writePrivateToken({
          token: key.token,
          fileDescriptor: Number(tokenFileDescriptor),
        });
      } else {
        if (tokenOutput === undefined) {
          throw new Error("--token-output is required");
        }
        writePrivateTokenPath({
          token: key.token,
          path: tokenOutput,
        });
      }
      await store.createKey(createdKeyId, accountId, key);
      process.stdout.write(
        `${JSON.stringify({ accountId, keyId: createdKeyId, tokenDelivery: "private-file-descriptor" })}\n`,
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

export function writePrivateToken(options: {
  readonly token: string;
  readonly fileDescriptor: number;
}): void {
  if (!Number.isInteger(options.fileDescriptor) || options.fileDescriptor < 3) {
    throw new Error("Private token file descriptor is invalid");
  }
  const stats = fstatSync(options.fileDescriptor);
  if (
    (!stats.isFile() && !stats.isFIFO()) ||
    (stats.mode & 0o077) !== 0 ||
    (stats.isFile() && stats.nlink !== 1)
  ) {
    throw new Error(
      "Private token channel must be an owner-only regular file or FIFO",
    );
  }
  writeSync(options.fileDescriptor, options.token, undefined, "ascii");
  if (stats.isFile()) fsyncSync(options.fileDescriptor);
}

export function writePrivateTokenPath(options: {
  readonly token: string;
  readonly path: string;
}): void {
  if (
    !options.path.startsWith("/run/skillwire-private/") ||
    options.path.includes("..")
  ) {
    throw new Error("Private token output path is invalid");
  }
  const stats = lstatSync(options.path);
  if (
    !stats.isFIFO() ||
    stats.isSymbolicLink() ||
    stats.uid !== process.getuid?.() ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error("Private token output must be an owner-only FIFO");
  }
  const descriptor = openSync(
    options.path,
    constants.O_WRONLY | constants.O_NOFOLLOW,
  );
  try {
    writeSync(descriptor, options.token, undefined, "ascii");
  } finally {
    closeSync(descriptor);
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${redactText(error instanceof Error ? error.message : "Authentication administration failed")}\n`,
    );
    process.exitCode = 1;
  });
}
