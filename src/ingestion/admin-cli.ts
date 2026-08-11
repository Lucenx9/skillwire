import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createPostgresPool } from "../persistence/postgres/client.js";
import { runMigrations } from "../persistence/postgres/migration-runner.js";
import { PostgresExternalCatalogStore } from "../persistence/postgres/external-catalog-store.js";
import { SourceRegistrationService } from "../application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../application/services/source-synchronization-service.js";
import { SourceDiscoveryService } from "../application/services/source-discovery-service.js";
import { assertGitHubCoordinate } from "../domain/external-catalog/types.js";
import type { CandidateClassification } from "../domain/external-catalog/types.js";
import { PostgresGitHubSourceStore } from "../persistence/postgres/github-source-store.js";
import { PostgresSyncLeaseStore } from "../persistence/postgres/sync-lease-store.js";
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
    if (args.length === 1) return { name };
    const values = namedArguments(args.slice(1));
    if (
      ![...values.keys()].every((key) => key === "--state" || key === "--limit")
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
    return {
      name,
      ...(state === undefined
        ? {}
        : { state: state as CandidateClassification }),
      ...(limit === undefined ? {} : { limit }),
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
    const sourceStore = new PostgresGitHubSourceStore(pool);
    const restClient = new GitHubRestClient({
      token,
      fetchImplementation: options.fetchImplementation,
    });
    const provider = new GitHubCommitTreeBlobReader(restClient);
    const registration = new SourceRegistrationService(provider, store);
    const synchronization = new SourceSynchronizationService(provider, store);
    const leases = new PostgresSyncLeaseStore(pool);
    const discovery = new SourceDiscoveryService(
      new GitHubSearchDiscoveryProvider(
        restClient,
        {
          querySetId: "recognized-layouts-v1",
          queries: [
            {
              query: "path:.claude-plugin filename:plugin.json",
              evidenceKind: "claude-plugin-manifest",
            },
            {
              query: "filename:SKILL.md",
              evidenceKind: "nested-skill-document",
            },
          ],
          maximumQueries: 2,
          maximumPagesPerQuery: 5,
          resultsPerPage: 100,
          maximumResults: 1000,
          maximumRequests: 1000,
          maximumResponseBytes: 8 * 1024 * 1024,
        },
        sourceStore,
      ),
      provider,
      sourceStore,
      "recognized-layouts-v1",
      {
        maximumQueries: 2,
        maximumPages: 10,
        maximumResults: 1000,
        maximumRequests: 1000,
        maximumResponseBytes: 8 * 1024 * 1024,
      },
    );
    if (command.name === "source:list") {
      return {
        ok: true,
        command: command.name,
        sources: await store.listAdministrativeSources(command.state),
        candidates: (
          await store.listAdministrativeCandidates(command.state)
        ).slice(0, command.limit ?? 100),
      };
    }
    if (command.name === "discover") {
      return {
        ok: true,
        command: command.name,
        ...(await discovery.enqueue()),
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
        )),
      };
    }
    if (command.name === "verify") {
      const candidate = (await store.listAdministrativeCandidates()).find(
        ({ candidateId }) => candidateId === command.candidateId,
      );
      if (candidate === undefined) throw new Error("NOT_FOUND");
      const lease = await leases.acquire(
        `sync/${candidate.sourceId}`,
        randomUUID(),
        60_000,
      );
      if (lease === undefined) throw new Error("LEASE_HELD");
      try {
        const published = await synchronization.syncWithLease(
          candidate.sourceId,
          lease,
        );
        return {
          ok: true,
          command: command.name,
          candidateId: command.candidateId,
          sourceId: candidate.sourceId,
          published,
        };
      } finally {
        await leases.release(lease);
      }
    }
    if (command.name === "source:sync") {
      const lease = await leases.acquire(
        `sync/${command.sourceId}`,
        randomUUID(),
        60_000,
      );
      if (lease === undefined) throw new Error("LEASE_HELD");
      try {
        return {
          ok: true,
          command: command.name,
          ...(await synchronization.syncWithLease(command.sourceId, lease)),
        };
      } finally {
        await leases.release(lease);
      }
    }
    const registered = await registration.add(
      { owner: command.owner, repository: command.repository },
      actor,
    );
    const lease = await leases.acquire(
      `sync/${registered.sourceId}`,
      randomUUID(),
      60_000,
    );
    if (lease === undefined) throw new Error("LEASE_HELD");
    let published;
    try {
      published = await synchronization.syncWithLease(
        registered.sourceId,
        lease,
      );
    } finally {
      await leases.release(lease);
    }
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
