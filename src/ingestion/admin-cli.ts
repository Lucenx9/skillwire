import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createPostgresPool } from "../persistence/postgres/client.js";
import { runMigrations } from "../persistence/postgres/migration-runner.js";
import { PostgresExternalCatalogStore } from "../persistence/postgres/external-catalog-store.js";
import { SourceRegistrationService } from "../application/services/source-registration-service.js";
import { SourceDiscoveryService } from "../application/services/source-discovery-service.js";
import { assertGitHubCoordinate } from "../domain/external-catalog/types.js";
import type { CandidateClassification } from "../domain/external-catalog/types.js";
import { PostgresGitHubSourceStore } from "../persistence/postgres/github-source-store.js";
import { GitHubCommitTreeBlobReader } from "./github/commit-tree-blob-reader.js";
import { GitHubSearchDiscoveryProvider } from "./github/discovery-provider.js";
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
  "NOT_FOUND",
  "NOT_VERIFIED",
  "LEASE_HELD",
  "ADMIN_UNAUTHORIZED",
  "CONFLICT",
  "CANCELLED",
]);

function publicErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "INTERNAL";
  if (error.message === "CLASSIFICATION_TRANSITION_INVALID")
    return "NOT_VERIFIED";
  if (error.message === "GITHUB_RATE_LIMITED") return "RATE_LIMITED";
  if (error.message === "GITHUB_TRANSIENT") return "GITHUB_UNAVAILABLE";
  if (error.message === "LEASE_LOST") return "LEASE_HELD";
  if (PUBLIC_ERROR_CODES.has(error.message)) return error.message;
  if (error.message.startsWith("GITHUB_HTTP_")) return "GITHUB_UNAVAILABLE";
  if (error.name === "AbortError" || error.name === "TimeoutError")
    return "CANCELLED";
  return "INTERNAL";
}

export type SourceAdminCommand =
  | {
      readonly name: "source:list";
      readonly state?: CandidateClassification | undefined;
      readonly limit?: number | undefined;
      readonly sourceId?: string | undefined;
      readonly cursor?: string | undefined;
    }
  | {
      readonly name: "source:add";
      readonly owner: string;
      readonly repository: string;
    }
  | { readonly name: "source:sync"; readonly sourceId: string }
  | { readonly name: "discover" }
  | { readonly name: "verify"; readonly candidateId: string }
  | {
      readonly name: "quarantine";
      readonly candidateId: string;
      readonly reasonCode: "ADMIN_QUARANTINE";
    }
  | { readonly name: "curate"; readonly candidateId: string };

export interface SourceAdminOptions {
  readonly fetchImplementation?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
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
  const rawName = args[0];
  const name =
    rawName === "list"
      ? "source:list"
      : rawName === "sync"
        ? "source:sync"
        : rawName;
  if (name === "source:list") {
    if (args.length === 1) return { name };
    const values = namedArguments(args.slice(1));
    if (
      ![...values.keys()].every(
        (key) =>
          key === "--state" ||
          key === "--limit" ||
          key === "--source-id" ||
          key === "--cursor",
      )
    ) {
      throw new Error("INVALID_INPUT");
    }
    const state = values.get("--state");
    if (
      state !== undefined &&
      !["discovered", "verified", "quarantined", "curated"].includes(state)
    ) {
      throw new Error("INVALID_INPUT");
    }
    const limitSource = values.get("--limit");
    const limit = limitSource === undefined ? undefined : Number(limitSource);
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > 100)
    ) {
      throw new Error("INVALID_INPUT");
    }
    const sourceId = values.get("--source-id");
    const cursor = values.get("--cursor");
    if (
      (sourceId !== undefined && !validUuid(sourceId)) ||
      (cursor !== undefined && !validUuid(cursor))
    ) {
      throw new Error("INVALID_INPUT");
    }
    return {
      name,
      ...(state === undefined
        ? {}
        : { state: state as CandidateClassification }),
      ...(limit === undefined ? {} : { limit }),
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }
  if (name === "discover") {
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
  if (name === "verify" || name === "curate") {
    const values = namedArguments(args.slice(1));
    const candidateId = values.get("--candidate-id");
    if (values.size !== 1 || !validUuid(candidateId))
      throw new Error("INVALID_INPUT");
    return { name, candidateId };
  }
  if (name === "quarantine") {
    const values = namedArguments(args.slice(1));
    const candidateId = values.get("--candidate-id");
    if (
      values.size !== 2 ||
      !validUuid(candidateId) ||
      values.get("--reason-code") !== "ADMIN_QUARANTINE"
    ) {
      throw new Error("INVALID_INPUT");
    }
    return { name, candidateId, reasonCode: "ADMIN_QUARANTINE" };
  }
  throw new Error("INVALID_INPUT");
}

function validUuid(value: string | undefined): value is string {
  return (
    value !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function adminBoundedInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const source = environment[name];
  if (source === undefined) return fallback;
  const value = Number(source);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error("INVALID_CONFIGURATION");
  }
  return value;
}

function adminDiscoveryQueries(
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const source = environment["SKILLWIRE_GITHUB_DISCOVERY_QUERIES"];
  if (source === undefined) {
    return ["filename:plugin.json path:.claude-plugin", "filename:SKILL.md"];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error("INVALID_CONFIGURATION");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 16 ||
    parsed.some(
      (query) =>
        typeof query !== "string" ||
        query.length < 1 ||
        query.length > 256 ||
        hasAsciiControl(query),
    )
  ) {
    throw new Error("INVALID_CONFIGURATION");
  }
  return [...new Set(parsed as string[])];
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
  if (environment["SKILLWIRE_ADMIN_AUTHORITY"] !== "active") {
    throw new Error("ADMIN_UNAUTHORIZED");
  }
  const timeout = Number(
    environment["SKILLWIRE_GITHUB_OPERATION_TIMEOUT_MS"] ?? "300000",
  );
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 900_000) {
    throw new Error("INVALID_CONFIGURATION");
  }
  const requestTimeout = adminBoundedInteger(
    environment,
    "SKILLWIRE_GITHUB_REQUEST_TIMEOUT_MS",
    30_000,
    120_000,
  );
  const maximumAttempts = adminBoundedInteger(
    environment,
    "SKILLWIRE_GITHUB_MAX_ATTEMPTS",
    3,
    4,
  );
  const maximumResponseBytes = adminBoundedInteger(
    environment,
    "SKILLWIRE_GITHUB_MAX_RESPONSE_BYTES",
    8 * 1024 * 1024,
    32 * 1024 * 1024,
  );
  const maximumRequests = adminBoundedInteger(
    environment,
    "SKILLWIRE_GITHUB_MAX_REQUESTS_PER_RUN",
    1000,
    2000,
  );
  const maximumResults = adminBoundedInteger(
    environment,
    "SKILLWIRE_GITHUB_MAX_RESULTS_PER_RUN",
    1000,
    4000,
  );
  const maximumPagesPerQuery = adminBoundedInteger(
    environment,
    "SKILLWIRE_GITHUB_MAX_PAGES_PER_QUERY",
    5,
    10,
  );
  const resultsPerPage = adminBoundedInteger(
    environment,
    "SKILLWIRE_GITHUB_RESULTS_PER_PAGE",
    100,
    100,
  );
  const maximumQueries = adminBoundedInteger(
    environment,
    "SKILLWIRE_GITHUB_MAX_QUERIES",
    8,
    16,
  );
  const discoveryQueries = adminDiscoveryQueries(environment);
  if (requestTimeout >= timeout || discoveryQueries.length > maximumQueries) {
    throw new Error("INVALID_CONFIGURATION");
  }
  const deadline = Date.now() + timeout;
  const timeoutSignal = AbortSignal.timeout(timeout);
  const signal =
    options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);
  const operation = { signal, deadline } as const;
  const token = environment["SKILLWIRE_GITHUB_TOKEN"];
  const pool = createPostgresPool(databaseUrl);
  try {
    await runMigrations(pool);
    const store = new PostgresExternalCatalogStore(pool);
    const sourceStore = new PostgresGitHubSourceStore(pool);
    const restClient = new GitHubRestClient({
      token,
      fetchImplementation: options.fetchImplementation,
      requestTimeoutMs: requestTimeout,
      maximumAttempts,
      maximumResponseBytes,
    });
    const provider = new GitHubCommitTreeBlobReader(restClient);
    const registration = new SourceRegistrationService(provider, store);
    const discovery = new SourceDiscoveryService(
      new GitHubSearchDiscoveryProvider(
        restClient,
        {
          querySetId: "recognized-layouts-v1",
          queries: discoveryQueries.map((query) => ({
            query,
            evidenceKind: query.includes("plugin.json")
              ? ("claude-plugin-manifest" as const)
              : ("nested-skill-document" as const),
          })),
          maximumQueries,
          maximumPagesPerQuery,
          resultsPerPage,
          maximumResults,
          maximumRequests,
          maximumResponseBytes,
        },
        sourceStore,
      ),
      provider,
      sourceStore,
      "recognized-layouts-v1",
      {
        maximumQueries,
        maximumPages: maximumQueries * maximumPagesPerQuery,
        maximumResults,
        maximumRequests,
        maximumResponseBytes,
      },
    );
    if (command.name === "source:list") {
      const page = await store.listAdministrativeCandidatesPage(
        {
          ...(command.state === undefined
            ? {}
            : { classification: command.state }),
          ...(command.sourceId === undefined
            ? {}
            : { sourceId: command.sourceId }),
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          limit: command.limit ?? 100,
        },
        operation,
      );
      return {
        ok: true,
        command: command.name,
        sources: await store.listAdministrativeSources(
          command.state,
          operation,
          command.sourceId,
        ),
        ...page,
      };
    }
    if (command.name === "discover") {
      return {
        ok: true,
        command: command.name,
        ...(await discovery.enqueue(operation)),
      };
    }
    if (command.name === "quarantine") {
      return {
        ok: true,
        command: command.name,
        ...(await store.transitionCandidate(
          command.candidateId,
          "quarantined",
          "administrator",
          actor,
          command.reasonCode,
          operation,
        )),
      };
    }
    if (command.name === "curate") {
      return {
        ok: true,
        command: command.name,
        ...(await store.transitionCandidate(
          command.candidateId,
          "curated",
          "administrator",
          actor,
          "ADMIN_CURATED",
          operation,
        )),
      };
    }
    if (command.name === "verify") {
      return {
        ok: true,
        command: command.name,
        candidateId: command.candidateId,
        ...(await sourceStore.enqueueCandidateVerification(
          command.candidateId,
          operation,
        )),
      };
    }
    if (command.name === "source:sync") {
      return {
        ok: true,
        command: command.name,
        ...(await sourceStore.enqueueSync(
          command.sourceId,
          "administrator",
          operation,
        )),
      };
    }
    const registered = await registration.add(
      { owner: command.owner, repository: command.repository },
      actor,
      operation,
    );
    const run = await sourceStore.enqueueSync(
      registered.sourceId,
      "registration",
      operation,
    );
    return { ok: true, command: command.name, ...registered, ...run };
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
