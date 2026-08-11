import { timingSafeEqual } from "node:crypto";

import type { Pool } from "pg";

import type { RepositoryMemoryStore } from "./application/ports/repository-memory-store.js";
import { AuditExpirationService } from "./application/services/audit-expiration-service.js";
import { createForgetRepoMemory } from "./application/use-cases/forget-repo-memory.js";
import { createListRepoMemory } from "./application/use-cases/list-repo-memory.js";
import { createLoadSkill } from "./application/use-cases/load-skill.js";
import { createReadSkillResource } from "./application/use-cases/read-skill-resource.js";
import { createRecordSkillOutcome } from "./application/use-cases/record-skill-outcome.js";
import { createSearchSkills } from "./application/use-cases/search-skills.js";
import {
  createApiKeyAuthenticator,
  type ApiKeyAuthenticator,
} from "./authentication/api-key-authenticator.js";
import { loadVerifiedCatalogProvider } from "./catalog/version-controlled-provider.js";
import type { CatalogCacheMode } from "./catalog/version-controlled-provider.js";
import type { VerifiedRevisionCache } from "./catalog/verified-revision-cache.js";
import type { ApplicationConfig } from "./config.js";
import { AuditCleanupScheduler } from "./lifecycle/audit-cleanup-scheduler.js";
import { ReadinessState } from "./lifecycle/readiness-state.js";
import {
  createSecurityLogger,
  silentSecurityLogger,
  type SecurityLogger,
} from "./observability/logger.js";
import { PostgresApiKeyStore } from "./persistence/postgres/api-key-store.js";
import { createPostgresPool } from "./persistence/postgres/client.js";
import { PostgresErasureAuditStore } from "./persistence/postgres/erasure-audit-store.js";
import { runMigrations } from "./persistence/postgres/migration-runner.js";
import { PostgresRepositoryMemoryStore } from "./persistence/postgres/repository-memory-store.js";
import { createApp } from "./transport/mcp/app.js";
import type { McpUseCases } from "./transport/mcp/server-factory.js";

const TEST_BEARER_TOKEN = "skillwire_test_0123456789abcdef";
const TEST_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const TEST_KEY_ID = "00000000-0000-4000-8000-000000000002";

function assembleUseCases(
  projectRoot: string,
  releaseId: string,
  memoryStore: RepositoryMemoryStore,
  catalogCache?: VerifiedRevisionCache,
  catalogCacheMode: CatalogCacheMode = "catalog-warm",
): McpUseCases {
  const provider =
    catalogCache === undefined
      ? loadVerifiedCatalogProvider(
          projectRoot,
          releaseId,
          undefined,
          catalogCacheMode,
        )
      : loadVerifiedCatalogProvider(
          projectRoot,
          releaseId,
          catalogCache,
          catalogCacheMode,
        );
  return {
    searchSkills: createSearchSkills(provider, memoryStore),
    loadSkill: createLoadSkill(provider, memoryStore),
    readSkillResource: createReadSkillResource(provider),
    listRepoMemory: createListRepoMemory(memoryStore),
    recordSkillOutcome: createRecordSkillOutcome(memoryStore),
    forgetRepoMemory: createForgetRepoMemory(memoryStore),
  };
}

function testAuthenticator(): ApiKeyAuthenticator {
  return {
    authenticate(token) {
      const candidate = Buffer.from(token);
      const expected = Buffer.from(TEST_BEARER_TOKEN);
      const matches =
        candidate.byteLength === expected.byteLength &&
        timingSafeEqual(candidate, expected);
      return Promise.resolve(
        matches
          ? { accountId: TEST_ACCOUNT_ID, apiKeyId: TEST_KEY_ID }
          : undefined,
      );
    },
  };
}

const unconfiguredMemoryStore: RepositoryMemoryStore = {
  recordUsage: () =>
    Promise.reject(new Error("Test memory store is not configured")),
  list: () => Promise.reject(new Error("Test memory store is not configured")),
  rankingProjection: () =>
    Promise.reject(new Error("Test memory store is not configured")),
  replaceOutcome: () =>
    Promise.reject(new Error("Test memory store is not configured")),
  forget: () =>
    Promise.reject(new Error("Test memory store is not configured")),
};

export interface Application {
  readonly app: ReturnType<typeof createApp>;
  readonly pool: Pool;
  readonly readiness: ReadinessState;
  checkReadiness(): Promise<boolean>;
  close(): Promise<void>;
}

async function probeRequiredDatabaseSchema(pool: Pool): Promise<void> {
  const result = await pool.query<{
    accounts: string | null;
    apiKeys: string | null;
    repositoryUsage: string | null;
    erasureAudit: string | null;
  }>(
    `
      SELECT
        to_regclass('public.accounts')::text AS accounts,
        to_regclass('public.api_keys')::text AS "apiKeys",
        to_regclass('public.repository_skill_usage')::text AS "repositoryUsage",
        to_regclass('public.repository_erasure_audit')::text AS "erasureAudit"
    `,
  );
  const row = result.rows[0];
  if (
    [row?.accounts, row?.apiKeys, row?.repositoryUsage, row?.erasureAudit].some(
      (value) => value === null || value === undefined,
    )
  ) {
    throw new Error("Required database schema is unavailable");
  }
}

export async function createApplication(
  config: ApplicationConfig,
  projectRoot = process.cwd(),
): Promise<Application> {
  const catalogRoot = config.catalogRoot ?? projectRoot;
  const catalogRelease = config.catalogRelease ?? "launch-catalog-v1";
  const pool = createPostgresPool(config.databaseUrl);
  const readiness = new ReadinessState();
  const logger = createSecurityLogger(undefined, config.logLevel ?? "info");
  try {
    await runMigrations(pool, `${catalogRoot}/migrations`);
    const memoryStore = new PostgresRepositoryMemoryStore(pool);
    const auditStore = new PostgresErasureAuditStore(pool);
    const expiration = new AuditExpirationService(auditStore);
    const scheduler = new AuditCleanupScheduler(
      () => expiration.cleanupExpired(),
      readiness,
      config.auditCleanupIntervalMilliseconds ?? 3_600_000,
      () => probeRequiredDatabaseSchema(pool),
    );
    const authenticator = createApiKeyAuthenticator(
      new PostgresApiKeyStore(pool, config.apiKeyPepper),
      config.apiKeyPepper,
    );
    const app = createApp({
      allowedHosts: config.allowedHosts ?? [config.host],
      authenticator,
      readiness,
      checkReadiness: () => scheduler.checkReadiness(),
      useCases: assembleUseCases(
        catalogRoot,
        catalogRelease,
        memoryStore,
        undefined,
        config.catalogCacheMode,
      ),
      logger,
      maximumRequestBodyBytes: config.maximumRequestBodyBytes ?? 65_536,
      requestDeadlineMilliseconds: config.requestDeadlineMilliseconds ?? 10_000,
      rateLimit: config.rateLimit ?? {
        accountRequestsPerMinute: 120,
        apiKeyRequestsPerMinute: 120,
        burst: 30,
      },
    });
    await scheduler.start();
    return {
      app,
      pool,
      readiness,
      checkReadiness: () => scheduler.checkReadiness(),
      close: async () => {
        scheduler.stop();
        await pool.end();
      },
    };
  } catch (error) {
    readiness.markNotReady();
    await pool.end();
    throw error;
  }
}

export interface TestApplicationOptions {
  readonly memoryStore?: RepositoryMemoryStore | undefined;
  readonly authenticator?: ApiKeyAuthenticator | undefined;
  readonly catalogCache?: VerifiedRevisionCache | undefined;
  readonly logger?: SecurityLogger | undefined;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly maximumRequestBodyBytes?: number | undefined;
  readonly requestDeadlineMilliseconds?: number | undefined;
  readonly rateLimit?:
    | {
        readonly accountRequestsPerMinute: number;
        readonly apiKeyRequestsPerMinute: number;
        readonly burst: number;
      }
    | undefined;
  readonly now?: (() => number) | undefined;
}

export function createTestApplication(
  options: TestApplicationOptions = {},
  projectRoot = process.cwd(),
) {
  const readiness = new ReadinessState();
  readiness.markReady();
  return {
    app: createApp({
      allowedHosts: options.allowedHosts ?? ["127.0.0.1", "localhost"],
      authenticator: options.authenticator ?? testAuthenticator(),
      readiness,
      useCases: assembleUseCases(
        projectRoot,
        "launch-catalog-v1",
        options.memoryStore ?? unconfiguredMemoryStore,
        options.catalogCache,
      ),
      logger: options.logger ?? silentSecurityLogger,
      maximumRequestBodyBytes: options.maximumRequestBodyBytes ?? 65_536,
      requestDeadlineMilliseconds:
        options.requestDeadlineMilliseconds ?? 10_000,
      rateLimit: options.rateLimit ?? {
        accountRequestsPerMinute: 60_000,
        apiKeyRequestsPerMinute: 60_000,
        burst: 1000,
      },
      now: options.now,
    }),
  };
}
