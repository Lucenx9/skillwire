/* eslint-disable @typescript-eslint/require-await -- Async fake mirrors the production command runner. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assessRestoredDatabaseEvidence,
  databaseStateExpectation,
  expectedMigrationInventory,
  validateRestoredDatabaseContainer,
  type RestoredDatabaseEvidence,
} from "../../../src/onboarding/adapters/postgres/restore-validation.js";
import { hashExternalAdvisoryEvent } from "../../../src/domain/external-catalog/external-advisory-chain.js";
import type { CommandOptions } from "../../../src/onboarding/adapters/process/command-runner.js";
import { createOnboardingEnvironment } from "../../helpers/onboarding-environment.js";

const REQUIRED_CONSTRAINTS = [
  "accounts_pkey",
  "accounts_status_check",
  "api_keys_account_id_fkey",
  "api_keys_pkey",
  "api_keys_public_id_key",
  "external_advisory_chain_head_pkey",
  "external_revision_advisory_events_pkey",
  "external_revision_dependencies_pkey",
  "external_revision_resources_pkey",
  "external_skill_revisions_pkey",
  "schema_migrations_checksum_check",
  "schema_migrations_pkey",
];

const REQUIRED_TRIGGERS = [
  "external_advisory_append_valid",
  "external_advisory_events_immutable",
  "external_dependencies_immutable",
  "external_resources_immutable",
  "external_revisions_immutable",
  "external_snapshots_immutable",
];

function evidence(options: {
  readonly accountId: string;
  readonly checksums: readonly string[];
}): RestoredDatabaseEvidence {
  const advisoryInput = {
    sequence: "1",
    previousEventSha256: "0".repeat(64),
    revisionId: randomUUID(),
    kind: "security" as const,
    status: "available" as const,
    reasonCode: "initial-publication",
    effectiveAt: "2026-01-01T00:00:00.000Z",
  };
  const eventSha256 = hashExternalAdvisoryEvent(advisoryInput);
  return {
    currentDatabase: "postgres",
    inRecovery: false,
    transactionReadOnly: "off",
    migrations: options.checksums.map((checksum, index) => ({
      version: String(index + 1).padStart(3, "0"),
      checksum,
    })),
    constraints: REQUIRED_CONSTRAINTS,
    triggers: REQUIRED_TRIGGERS,
    catalog: {
      snapshotCount: 1,
      revisionCount: 2,
      resourceCount: 3,
      dependencyCount: 1,
      contentObjectCount: 5,
      identitySha256: "c".repeat(64),
      invalidSnapshotCounts: 0,
      invalidPublishedPointers: 0,
      invalidContentLengths: 0,
      invalidContentHashes: 0,
      invalidSnapshotAdvisoryHeads: 0,
    },
    advisory: {
      lastSequence: "1",
      lastEventSha256: eventSha256,
      events: [{ ...advisoryInput, eventSha256 }],
    },
    authoritativeState: {
      installationAccountStatus: "active",
      activeApiKeyCount: 2,
      repositoryUsageRows: 3,
      repositoryErasureRows: 1,
    },
  };
}

describe("production restored-database validation", () => {
  it("requires the complete immutable migration inventory and checksums", async () => {
    const fixture = await createOnboardingEnvironment();
    try {
      const migrations = resolve(fixture.root, "migrations");
      await mkdir(migrations, { mode: 0o700 });
      await writeFile(resolve(migrations, "001_first.sql"), "SELECT 1;\n");
      await writeFile(resolve(migrations, "002_second.sql"), "SELECT 2;\n");

      const expected = await expectedMigrationInventory(migrations, "002");
      expect(expected).toEqual([
        {
          version: "001",
          checksum: createHash("sha256").update("SELECT 1;\n").digest("hex"),
        },
        {
          version: "002",
          checksum: createHash("sha256").update("SELECT 2;\n").digest("hex"),
        },
      ]);
      const accountId = randomUUID();
      const valid = evidence({
        accountId,
        checksums: expected.map(({ checksum }) => checksum),
      });
      expect(
        assessRestoredDatabaseEvidence(valid, {
          expectedMigrations: expected,
          installationAccountId: accountId,
          expectedActiveApiKeys: 2,
          expectedDatabase: "postgres",
          expectedState: databaseStateExpectation(valid),
        }),
      ).toMatchObject({
        latestMigration: "002",
        migrationInventoryValid: true,
        constraintsValid: true,
        catalogValid: true,
        advisoryValid: true,
        authoritativeStateValid: true,
        ready: true,
      });

      expect(() =>
        assessRestoredDatabaseEvidence(
          {
            ...valid,
            migrations: valid.migrations.slice(0, 1),
          },
          {
            expectedMigrations: expected,
            installationAccountId: accountId,
            expectedActiveApiKeys: 2,
            expectedDatabase: "postgres",
            expectedState: databaseStateExpectation(valid),
          },
        ),
      ).toThrow(/migration inventory/i);
      expect(() =>
        assessRestoredDatabaseEvidence(
          {
            ...valid,
            migrations: valid.migrations.map((migration, index) =>
              index === 1
                ? { ...migration, checksum: "f".repeat(64) }
                : migration,
            ),
          },
          {
            expectedMigrations: expected,
            installationAccountId: accountId,
            expectedActiveApiKeys: 2,
            expectedDatabase: "postgres",
            expectedState: databaseStateExpectation(valid),
          },
        ),
      ).toThrow(/migration inventory/i);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a symlinked expected-migration directory", async () => {
    const fixture = await createOnboardingEnvironment();
    try {
      const outside = resolve(fixture.root, "outside-migrations");
      await mkdir(outside, { mode: 0o700 });
      await writeFile(resolve(outside, "001_first.sql"), "SELECT 1;\n");
      const linked = resolve(fixture.root, "linked-migrations");
      await symlink(outside, linked);

      await expect(expectedMigrationInventory(linked, "001")).rejects.toThrow(
        /migration.*directory|symbolic link|unsafe/i,
      );
    } finally {
      await fixture.close();
    }
  });

  it.each([
    [
      "required constraint",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        constraints: value.constraints.slice(1),
      }),
    ],
    [
      "catalog integrity",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        catalog: { ...value.catalog, invalidContentLengths: 1 },
      }),
    ],
    [
      "advisory integrity",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        advisory: { ...value.advisory, lastEventSha256: "f".repeat(64) },
      }),
    ],
    [
      "authoritative account",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        authoritativeState: {
          ...value.authoritativeState,
          installationAccountStatus: null,
        },
      }),
    ],
    [
      "active API keys",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        authoritativeState: {
          ...value.authoritativeState,
          activeApiKeyCount: 1,
        },
      }),
    ],
    [
      "duplicated authoritative rows",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        authoritativeState: {
          ...value.authoritativeState,
          repositoryUsageRows: value.authoritativeState.repositoryUsageRows + 1,
        },
      }),
    ],
    [
      "catalog identity drift",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        catalog: {
          ...value.catalog,
          revisionCount: value.catalog.revisionCount + 1,
        },
      }),
    ],
    [
      "database readiness",
      (value: RestoredDatabaseEvidence) => ({ ...value, inRecovery: true }),
    ],
  ] as const)(
    "rejects restored data with invalid %s evidence",
    (_name, corrupt) => {
      const accountId = randomUUID();
      const checksum = "a".repeat(64);
      const valid = evidence({ accountId, checksums: [checksum] });
      expect(() =>
        assessRestoredDatabaseEvidence(corrupt(valid), {
          expectedMigrations: [{ version: "001", checksum }],
          installationAccountId: accountId,
          expectedActiveApiKeys: 2,
          expectedDatabase: "postgres",
          expectedState: databaseStateExpectation(valid),
        }),
      ).toThrow(/restore validation/i);
    },
  );

  it("queries raw production evidence and rejects corrupt callback output", async () => {
    const accountId = randomUUID();
    const checksum = "b".repeat(64);
    const commands: CommandOptions[] = [];
    const run = vi.fn(async (options: CommandOptions) => {
      commands.push(options);
      return {
        code: 0,
        stdout: `${JSON.stringify({
          ...evidence({ accountId, checksums: [checksum] }),
          catalog: {
            ...evidence({ accountId, checksums: [checksum] }).catalog,
            invalidPublishedPointers: 1,
          },
        })}\n`,
        stderr: "",
        durationMilliseconds: 1,
      };
    });

    await expect(
      validateRestoredDatabaseContainer({
        dockerExecutable: "/usr/bin/docker",
        containerName: "skillwire-backup-validate-deadbeefdeadbeef",
        environment: { HOME: "/tmp/disposable-home" },
        signal: new AbortController().signal,
        expectedMigrations: [{ version: "001", checksum }],
        installationAccountId: accountId,
        expectedActiveApiKeys: 2,
        expectedState: databaseStateExpectation(
          evidence({ accountId, checksums: [checksum] }),
        ),
        run,
      }),
    ).rejects.toThrow(/restore validation/i);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args.slice(0, 3)).toEqual([
      "exec",
      "skillwire-backup-validate-deadbeefdeadbeef",
      "psql",
    ]);
    const query = commands[0]?.args.at(-1) ?? "";
    expect(query).toContain("schema_migrations");
    expect(query).toContain("pg_constraint");
    expect(query).toContain("external_revision_advisory_events");
    expect(query).toContain("external_content_objects");
    expect(query).toContain("repository_skill_usage");
    expect(query).not.toMatch(/AS\s+(?:invariants|catalog|advisory)_valid/i);
  });
});
