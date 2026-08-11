import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createPostgresPool } from "../persistence/postgres/client.js";
import { runMigrations } from "../persistence/postgres/migration-runner.js";
import { PostgresExternalCatalogStore } from "../persistence/postgres/external-catalog-store.js";
import { SourceRegistrationService } from "../application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../application/services/source-synchronization-service.js";
import { assertGitHubCoordinate } from "../domain/external-catalog/types.js";
import { GitHubCommitTreeBlobReader } from "./github/commit-tree-blob-reader.js";
import { GitHubRestClient } from "./github/rest-client.js";

function required(value: string | undefined, code: string): string {
  if (value === undefined || value.length === 0) throw new Error(code);
  return value;
}

const PUBLIC_ERROR_CODES = new Set([
  "INVALID_INPUT",
  "INVALID_CONFIGURATION",
  "SOURCE_NOT_FOUND",
  "SOURCE_NOT_PUBLIC",
  "COMMIT_MISMATCH",
  "TREE_TRUNCATED",
  "TREE_OVERSIZED",
  "TREE_AMBIGUOUS",
  "OBJECT_UNSUPPORTED",
  "PATH_UNSAFE",
  "MANIFEST_OVERSIZED",
  "LICENSE_CONFLICT",
  "PUBLICATION_CONFLICT",
  "HASH_MISMATCH",
]);

function publicErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "INTERNAL";
  if (PUBLIC_ERROR_CODES.has(error.message)) return error.message;
  if (error.message.startsWith("GITHUB_HTTP_")) return "GITHUB_UNAVAILABLE";
  if (error.name === "AbortError" || error.name === "TimeoutError")
    return "CANCELLED";
  return "INTERNAL";
}

export type SourceAdminCommand =
  | { readonly name: "source:list" }
  | {
      readonly name: "source:add";
      readonly owner: string;
      readonly repository: string;
    }
  | { readonly name: "source:sync"; readonly sourceId: string };

export interface SourceAdminOptions {
  readonly fetchImplementation?: typeof fetch | undefined;
}

function namedArguments(args: readonly string[]): ReadonlyMap<string, string> {
  if (args.length % 2 !== 0) throw new Error("INVALID_INPUT");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !name.startsWith("--") ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error("INVALID_INPUT");
    }
    values.set(name, value);
  }
  return values;
}

export function parseSourceAdminCommand(
  args: readonly string[],
): SourceAdminCommand {
  const name = args[0];
  if (name === "source:list") {
    if (args.length !== 1) throw new Error("INVALID_INPUT");
    return { name };
  }
  if (name === "source:add") {
    const values = namedArguments(args.slice(1));
    if (
      values.size !== 2 ||
      !values.has("--owner") ||
      !values.has("--repository")
    ) {
      throw new Error("INVALID_INPUT");
    }
    const coordinate = assertGitHubCoordinate({
      owner: required(values.get("--owner"), "INVALID_INPUT"),
      repository: required(values.get("--repository"), "INVALID_INPUT"),
    });
    return { name, ...coordinate };
  }
  if (name === "source:sync") {
    const values = namedArguments(args.slice(1));
    const sourceId = values.get("--source-id");
    if (
      values.size !== 1 ||
      sourceId === undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        sourceId,
      )
    ) {
      throw new Error("INVALID_INPUT");
    }
    return { name, sourceId };
  }
  throw new Error("INVALID_INPUT");
}

export async function runSourceAdmin(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  options: SourceAdminOptions = {},
): Promise<unknown> {
  const command = parseSourceAdminCommand(args);
  const databaseUrl = required(
    environment["DATABASE_URL"],
    "INVALID_CONFIGURATION",
  );
  const actor = required(
    environment["SKILLWIRE_ADMIN_ACTOR_ID"],
    "INVALID_CONFIGURATION",
  );
  if (!/^[A-Za-z0-9_.:@-]{1,160}$/.test(actor)) {
    throw new Error("INVALID_CONFIGURATION");
  }
  const token = environment["SKILLWIRE_GITHUB_TOKEN"];
  const pool = createPostgresPool(databaseUrl);
  try {
    await runMigrations(pool);
    const store = new PostgresExternalCatalogStore(pool);
    const provider = new GitHubCommitTreeBlobReader(
      new GitHubRestClient({
        token,
        fetchImplementation: options.fetchImplementation,
      }),
    );
    const registration = new SourceRegistrationService(provider, store);
    const synchronization = new SourceSynchronizationService(provider, store);
    if (command.name === "source:list") {
      return {
        ok: true,
        command: command.name,
        sources: await registration.list(),
      };
    }
    if (command.name === "source:sync") {
      return {
        ok: true,
        command: command.name,
        ...(await synchronization.sync(command.sourceId)),
      };
    }
    const registered = await registration.add(
      { owner: command.owner, repository: command.repository },
      actor,
    );
    const published = await synchronization.sync(registered.sourceId);
    return { ok: true, command: command.name, ...registered, published };
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  runSourceAdmin(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, errorCode: publicErrorCode(error) })}\n`,
      );
      process.exitCode = 1;
    });
}
