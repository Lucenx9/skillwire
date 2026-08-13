import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createApplication,
  type Application,
} from "../../../src/composition.js";
import { loadConfig } from "../../../src/config.js";
import { startHttpService } from "../../../src/main.js";
import { silentSecurityLogger } from "../../../src/observability/logger.js";
import { PostgresApiKeyStore } from "../../../src/persistence/postgres/api-key-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

const pepper = "composition-pepper-that-is-at-least-thirty-two-bytes";

describe("composed service startup", () => {
  let database: TestDatabase;
  let application: Application;
  let accountId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    accountId = randomUUID();
    await new PostgresApiKeyStore(database.pool, pepper).createAccount(
      accountId,
    );
    await database.pool.query(
      `
        INSERT INTO repository_erasure_audit (
          account_id,
          request_id,
          created_at,
          expires_at,
          operation_result,
          removed_record_count
        ) VALUES (
          $1,
          $2,
          statement_timestamp() - interval '31 days',
          statement_timestamp() - interval '1 day',
          'forgotten',
          0
        )
      `,
      [accountId, randomUUID()],
    );
    application = await createApplication({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: database.connectionString,
      apiKeyPepper: pepper,
    });
  }, 120_000);

  afterAll(async () => {
    await application.close();
    await database.close();
  });

  it("runs migrations and expired-audit cleanup before readiness", async () => {
    expect(application.readiness.isReady()).toBe(true);
    const response = await application.app.request("/health/ready", {
      headers: { host: "127.0.0.1" },
    });
    expect(response.status).toBe(200);
    const expired = await database.pool.query<{ count: string }>(
      `
        SELECT count(*)
        FROM repository_erasure_audit
        WHERE expires_at <= statement_timestamp()
      `,
    );
    expect(expired.rows[0]?.count).toBe("0");
  });

  it("refuses startup before readiness when the database is newer than the binary", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "skillwire-pre-010-binary-"),
    );
    const migrationRoot = join(projectRoot, "migrations");
    mkdirSync(migrationRoot);
    try {
      for (const name of readdirSync(join(process.cwd(), "migrations")).filter(
        (name) => /^00[1-9]_.*\.sql$/.test(name),
      )) {
        writeFileSync(
          join(migrationRoot, name),
          readFileSync(join(process.cwd(), "migrations", name)),
        );
      }
      await expect(
        createApplication(
          {
            host: "127.0.0.1",
            port: 0,
            databaseUrl: database.connectionString,
            apiKeyPepper: pepper,
            catalogRoot: projectRoot,
          },
          projectRoot,
        ),
      ).rejects.toThrow(
        /database migration 010 is newer than binary migration 009/i,
      );
      expect(application.readiness.isReady()).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("transitions through a real PostgreSQL outage and recovery cleanup", async () => {
    await database.simulateOutage();
    const unavailable = await application.app.request("/health/ready", {
      headers: { host: "127.0.0.1" },
    });
    expect(unavailable.status).toBe(503);
    expect(application.readiness.isReady()).toBe(false);

    await database.recover();
    await database.pool.query(
      `
        INSERT INTO repository_erasure_audit (
          account_id,
          request_id,
          created_at,
          expires_at,
          operation_result,
          removed_record_count
        ) VALUES (
          $1,
          $2,
          statement_timestamp() - interval '31 days',
          statement_timestamp() - interval '1 day',
          'forgotten',
          0
        )
      `,
      [accountId, randomUUID()],
    );
    const recovered = await application.app.request("/health/ready", {
      headers: { host: "127.0.0.1" },
    });
    expect(recovered.status).toBe(200);
    const expired = await database.pool.query<{ count: string }>(
      "SELECT count(*) FROM repository_erasure_audit WHERE expires_at <= statement_timestamp()",
    );
    expect(expired.rows[0]?.count).toBe("0");
  });

  it("fails startup configuration when required secrets are missing or ambiguous", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() =>
      loadConfig({
        DATABASE_URL: database.connectionString,
        DATABASE_URL_FILE: "/run/secrets/database-url",
        SKILLWIRE_API_KEY_PEPPER: pepper,
      }),
    ).toThrow();
  });

  it("loads required values from bounded secret files", () => {
    const directory = mkdtempSync(join(tmpdir(), "skillwire-config-"));
    const databasePath = join(directory, "database-url");
    const pepperPath = join(directory, "api-key-pepper");
    try {
      writeFileSync(databasePath, `${database.connectionString}\n`);
      writeFileSync(pepperPath, `${pepper}\n`);
      const config = loadConfig({
        DATABASE_URL_FILE: databasePath,
        SKILLWIRE_API_KEY_PEPPER_FILE: pepperPath,
        SKILLWIRE_CATALOG_ROOT: process.cwd(),
      });

      expect(config.databaseUrl).toBe(database.connectionString);
      expect(config.apiKeyPepper).toBe(pepper);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("keeps live ingestion disabled by default and requires an explicit credential when enabled", () => {
    const base = {
      DATABASE_URL: database.connectionString,
      SKILLWIRE_API_KEY_PEPPER: pepper,
      SKILLWIRE_CATALOG_ROOT: process.cwd(),
    };
    expect(loadConfig(base).githubIngestion).toMatchObject({ enabled: false });
    expect(() =>
      loadConfig({
        ...base,
        SKILLWIRE_GITHUB_INGESTION_ENABLED: "true",
      }),
    ).toThrow(/SKILLWIRE_GITHUB_TOKEN/);
    expect(
      loadConfig({
        ...base,
        SKILLWIRE_GITHUB_INGESTION_ENABLED: "true",
        SKILLWIRE_GITHUB_TOKEN: "github-test-token-with-bounded-length",
      }).githubIngestion,
    ).toMatchObject({
      enabled: true,
      schedulerIntervalMilliseconds: 60_000,
      discoveryCadenceMilliseconds: 3_600_000,
    });
    expect(() =>
      loadConfig({
        ...base,
        SKILLWIRE_GITHUB_REQUEST_TIMEOUT_MS: "60000",
        SKILLWIRE_GITHUB_OPERATION_TIMEOUT_MS: "60000",
      }),
    ).toThrow("GitHub ingestion budgets are inconsistent");
    expect(() =>
      loadConfig({
        ...base,
        SKILLWIRE_GITHUB_DISCOVERY_QUERIES: JSON.stringify([
          "filename:SKILL.md",
          "filename:plugin.json",
        ]),
        SKILLWIRE_GITHUB_MAX_QUERIES: "1",
      }),
    ).toThrow("GitHub ingestion budgets are inconsistent");
  });

  it("starts and stops the optional scheduler without contacting GitHub during startup or readiness", async () => {
    const scheduled = await createApplication({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: database.connectionString,
      apiKeyPepper: pepper,
      githubIngestion: {
        enabled: true,
        token: "github-test-token-with-bounded-length",
        schedulerIntervalMilliseconds: 120_000,
        discoveryCadenceMilliseconds: 3_600_000,
        sourceCadenceMilliseconds: 3_600_000,
        leaseDurationMilliseconds: 60_000,
        maximumSourcesPerTick: 10,
        maximumRequests: 512,
        maximumResponseBytes: 8 * 1024 * 1024,
        maximumResults: 1000,
        maximumPagesPerQuery: 5,
        resultsPerPage: 100,
        discoveryQueries: [
          "filename:plugin.json path:.claude-plugin",
          "filename:SKILL.md",
        ],
        maximumQueries: 8,
        maximumTreeEntries: 20_000,
        maximumCandidates: 256,
        maximumResourcesPerSkill: 64,
        maximumDependenciesPerSkill: 32,
        maximumTextBytes: 256 * 1024,
        maximumBundleBytes: 2 * 1024 * 1024,
        maximumRepositoryBytes: 32 * 1024 * 1024,
        requestTimeoutMilliseconds: 30_000,
        operationTimeoutMilliseconds: 300_000,
        maximumAttempts: 3,
        globalJobs: 2,
      },
    });
    try {
      expect(await scheduled.checkReadiness()).toBe(true);
    } finally {
      await scheduled.close();
    }
  });

  it("stops accepting requests and closes application resources cleanly", async () => {
    const service = await startHttpService(
      {
        host: "127.0.0.1",
        allowedHosts: ["127.0.0.1"],
        port: 0,
        databaseUrl: database.connectionString,
        apiKeyPepper: pepper,
        shutdownGraceMilliseconds: 1000,
      },
      silentSecurityLogger,
    );

    await service.close();
    expect(service.server.listening).toBe(false);
    expect(service.application.readiness.isReady()).toBe(false);
  });
});
