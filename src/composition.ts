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
import type { ApplicationConfig } from "./config.js";
import { AuditCleanupScheduler } from "./lifecycle/audit-cleanup-scheduler.js";
import { ReadinessState } from "./lifecycle/readiness-state.js";
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
  memoryStore: RepositoryMemoryStore,
): McpUseCases {
  const provider = loadVerifiedCatalogProvider(
    projectRoot,
    "launch-catalog-v1",
  );
  return {
    searchSkills: createSearchSkills(provider.listMetadata(), memoryStore),
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
  close(): Promise<void>;
}

export async function createApplication(
  config: ApplicationConfig,
  projectRoot = process.cwd(),
): Promise<Application> {
  const pool = createPostgresPool(config.databaseUrl);
  const readiness = new ReadinessState();
  try {
    await runMigrations(pool, `${projectRoot}/migrations`);
    const memoryStore = new PostgresRepositoryMemoryStore(pool);
    const auditStore = new PostgresErasureAuditStore(pool);
    const expiration = new AuditExpirationService(auditStore);
    const scheduler = new AuditCleanupScheduler(
      () => expiration.cleanupExpired(),
      readiness,
    );
    const authenticator = createApiKeyAuthenticator(
      new PostgresApiKeyStore(pool, config.apiKeyPepper),
      config.apiKeyPepper,
    );
    const app = createApp({
      host: config.host,
      authenticator,
      readiness,
      useCases: assembleUseCases(projectRoot, memoryStore),
    });
    await scheduler.start();
    return {
      app,
      pool,
      readiness,
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
}

export function createTestApplication(
  options: TestApplicationOptions = {},
  projectRoot = process.cwd(),
) {
  const readiness = new ReadinessState();
  readiness.markReady();
  return {
    app: createApp({
      host: "127.0.0.1",
      authenticator: options.authenticator ?? testAuthenticator(),
      readiness,
      useCases: assembleUseCases(
        projectRoot,
        options.memoryStore ?? unconfiguredMemoryStore,
      ),
    }),
  };
}
