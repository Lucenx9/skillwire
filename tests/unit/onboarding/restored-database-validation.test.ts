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

const REQUIRED_CONSTRAINT_NAMES = [
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

const REQUIRED_CONSTRAINTS: RestoredDatabaseEvidence["constraints"] =
  REQUIRED_CONSTRAINT_NAMES.map((constraintName) => ({
    schemaName: "public",
    tableName: constraintName.split("_").slice(0, -1).join("_") || "accounts",
    constraintName,
    constraintType: constraintName.endsWith("_pkey")
      ? ("primary-key" as const)
      : constraintName.endsWith("_fkey")
        ? ("foreign-key" as const)
        : ("check" as const),
    definition: `fixture definition for ${constraintName}`,
    validated: true,
  }));

function trigger(
  triggerName: string,
  tableName: string,
  functionName: string,
  events: RestoredDatabaseEvidence["triggers"][number]["events"],
  timing: RestoredDatabaseEvidence["triggers"][number]["timing"] = "BEFORE",
  level: RestoredDatabaseEvidence["triggers"][number]["level"] = "ROW",
): RestoredDatabaseEvidence["triggers"][number] {
  const functionBodySha256 = {
    reject_external_history_mutation:
      "4adf876c6bd96600896c6d48b63a2900408722ed33f8603af7a413555788e83c",
    protect_github_registration_identity:
      "b7e09311ad9c92f1d002dabe2991ee0e987071de9dfcec937f17fe62fab8071e",
    validate_external_classification_transition:
      "511e1833ab29d867a5c5a7ad5036aaabac942dab4e4f55d3de3247a0322507cd",
    validate_external_advisory_append:
      "ec80f70ea91225d44339c1a6aef7da0569e6aee6630f57c495430546fb6178df",
    guard_external_snapshot_finalization:
      "37167092120146842dfe2976dfcc45034ea58ad6eb4a4a576b0e0fd0e3ada9c9",
    require_external_snapshot_finalization:
      "e26c0466292fb76c9f4cce6af78ea7f617617d7a5f117fd20e15f3bfbbfdde8c",
    validate_external_revision_classification_transition:
      "01461630956a69c1ead4bfd7bf1df621e217a352052123fcfe79e401dea840b8",
    validate_external_snapshot_byte_total_projection:
      "6c866c631670b92a1ea5082ad0440ce207c0a53274073871acdcf45de5d18877",
  }[functionName];
  if (functionBodySha256 === undefined)
    throw new Error("Test trigger function is not release-bound");
  return {
    schemaName: "public",
    tableName,
    triggerName,
    functionSchema: "public",
    functionName,
    functionArguments: "",
    functionDefinition: `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS 'fixture'`,
    functionBodySha256,
    timing,
    level,
    deferrable:
      triggerName === "external_snapshot_finalization_required" ||
      triggerName === "external_snapshot_byte_total_projection_valid",
    initiallyDeferred:
      triggerName === "external_snapshot_finalization_required" ||
      triggerName === "external_snapshot_byte_total_projection_valid",
    events,
    enabled: "origin",
    definition: `CREATE TRIGGER ${triggerName} ${timing} ${events.join(" OR ")} ON ${tableName} FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
  };
}

const REQUIRED_TRIGGERS: RestoredDatabaseEvidence["triggers"] = [
  trigger(
    "external_content_immutable",
    "external_content_objects",
    "reject_external_history_mutation",
    ["DELETE", "UPDATE"],
  ),
  trigger(
    "external_identities_immutable",
    "external_skill_identities",
    "reject_external_history_mutation",
    ["DELETE", "UPDATE"],
  ),
  trigger(
    "external_revisions_immutable",
    "external_skill_revisions",
    "reject_external_history_mutation",
    ["DELETE", "UPDATE"],
  ),
  trigger(
    "external_resources_immutable",
    "external_revision_resources",
    "reject_external_history_mutation",
    ["DELETE", "UPDATE"],
  ),
  trigger(
    "external_dependencies_immutable",
    "external_revision_dependencies",
    "reject_external_history_mutation",
    ["DELETE", "UPDATE"],
  ),
  trigger(
    "external_observations_immutable",
    "external_snapshot_skill_observations",
    "reject_external_history_mutation",
    ["DELETE", "UPDATE"],
  ),
  trigger(
    "github_source_registration_identity_immutable",
    "github_source_registrations",
    "protect_github_registration_identity",
    ["DELETE", "UPDATE"],
  ),
  trigger(
    "external_classification_transition_valid",
    "external_classification_events",
    "validate_external_classification_transition",
    ["INSERT"],
  ),
  trigger(
    "external_advisory_append_valid",
    "external_revision_advisory_events",
    "validate_external_advisory_append",
    ["INSERT"],
  ),
  ...[
    ["external_candidates_immutable", "external_import_candidates"],
    ["external_reports_immutable", "external_verification_reports"],
    ["external_findings_immutable", "external_validation_findings"],
    [
      "external_classification_events_immutable",
      "external_classification_events",
    ],
    ["external_curation_decisions_immutable", "external_curation_decisions"],
    ["external_advisory_events_immutable", "external_revision_advisory_events"],
  ].map(([triggerName, tableName]) =>
    trigger(
      triggerName ?? "invalid",
      tableName ?? "invalid",
      "reject_external_history_mutation",
      ["DELETE", "UPDATE"],
    ),
  ),
  trigger(
    "github_sync_candidate_results_immutable",
    "github_sync_candidate_results",
    "reject_external_history_mutation",
    ["DELETE", "UPDATE"],
  ),
  trigger(
    "external_snapshots_immutable",
    "external_source_snapshots",
    "guard_external_snapshot_finalization",
    ["DELETE", "UPDATE"],
  ),
  trigger(
    "external_snapshot_finalization_required",
    "external_source_snapshots",
    "require_external_snapshot_finalization",
    ["INSERT", "UPDATE"],
    "AFTER",
  ),
  trigger(
    "external_revision_classification_transition_valid",
    "external_revision_classification_events",
    "validate_external_revision_classification_transition",
    ["INSERT"],
  ),
  trigger(
    "external_revision_classification_events_immutable",
    "external_revision_classification_events",
    "reject_external_history_mutation",
    ["DELETE", "UPDATE"],
  ),
  trigger(
    "external_snapshot_byte_total_projection_valid",
    "external_source_snapshots",
    "validate_external_snapshot_byte_total_projection",
    ["INSERT", "UPDATE"],
    "AFTER",
  ),
  trigger(
    "external_snapshot_byte_total_reconciliations_immutable",
    "external_snapshot_byte_total_reconciliations",
    "reject_external_history_mutation",
    ["DELETE", "UPDATE"],
  ),
  trigger(
    "external_snapshot_byte_total_reconciliations_truncate_rejected",
    "external_snapshot_byte_total_reconciliations",
    "reject_external_history_mutation",
    ["TRUNCATE"],
    "BEFORE",
    "STATEMENT",
  ),
];

function evidence(options: {
  readonly accountId: string;
  readonly checksums: readonly string[];
  readonly triggers?: RestoredDatabaseEvidence["triggers"];
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
    triggers: options.triggers ?? [],
    catalog: {
      snapshotCount: 1,
      revisionCount: 2,
      resourceCount: 3,
      dependencyCount: 1,
      contentObjectCount: 5,
      identitySha256: "c".repeat(64),
      legacySnapshotByteTotals: 0,
      invalidSnapshotByteTotals: 0,
      invalidSnapshotByteOverflows: 0,
      invalidSnapshotObjectGraph: 0,
      invalidRevisionHashes: 0,
      invalidSnapshotReconciliations: 0,
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
  it("accepts only the exact legacy byte-total representation before migration 011", () => {
    const accountId = randomUUID();
    const checksums = Array.from({ length: 10 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0"),
    );
    const legacy = evidence({
      accountId,
      checksums,
      triggers: REQUIRED_TRIGGERS.slice(0, -3),
    });
    legacy.catalog.legacySnapshotByteTotals = 1;

    expect(
      assessRestoredDatabaseEvidence(legacy, {
        expectedMigrations: legacy.migrations,
        installationAccountId: accountId,
        expectedActiveApiKeys: 2,
        expectedDatabase: "postgres",
        expectedState: databaseStateExpectation(legacy),
      }),
    ).toMatchObject({
      latestMigration: "010",
      catalogValid: true,
    });

    const arbitraryMismatch: RestoredDatabaseEvidence = {
      ...legacy,
      catalog: {
        ...legacy.catalog,
        legacySnapshotByteTotals: 0,
        invalidSnapshotByteTotals: 1,
      },
    };
    expect(() =>
      assessRestoredDatabaseEvidence(arbitraryMismatch, {
        expectedMigrations: arbitraryMismatch.migrations,
        installationAccountId: accountId,
        expectedActiveApiKeys: 2,
        expectedDatabase: "postgres",
        expectedState: databaseStateExpectation(legacy),
      }),
    ).toThrow(/restore validation/i);
  });

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
      "snapshot byte overflow",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        catalog: { ...value.catalog, invalidSnapshotByteOverflows: 1 },
      }),
    ],
    [
      "duplicate snapshot accounting",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        catalog: { ...value.catalog, invalidSnapshotObjectGraph: 1 },
      }),
    ],
    [
      "canonical revision hash",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        catalog: { ...value.catalog, invalidRevisionHashes: 1 },
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

  it("accepts the complete migration-010 schema-control inventory", () => {
    const accountId = randomUUID();
    const checksums = Array.from({ length: 10 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0"),
    );
    const valid = evidence({
      accountId,
      checksums,
      triggers: REQUIRED_TRIGGERS.slice(0, -3),
    });

    expect(
      assessRestoredDatabaseEvidence(valid, {
        expectedMigrations: valid.migrations,
        installationAccountId: accountId,
        expectedActiveApiKeys: 2,
        expectedDatabase: "postgres",
        expectedState: databaseStateExpectation(valid),
      }),
    ).toMatchObject({
      latestMigration: "010",
      constraintsValid: true,
      ready: true,
    });
  });

  it("requires the append-only byte-total reconciliation ledger after migration 011", () => {
    const accountId = randomUUID();
    const checksums = Array.from({ length: 11 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0"),
    );
    const valid = evidence({
      accountId,
      checksums,
      triggers: REQUIRED_TRIGGERS,
    });

    expect(
      assessRestoredDatabaseEvidence(valid, {
        expectedMigrations: valid.migrations,
        installationAccountId: accountId,
        expectedActiveApiKeys: 2,
        expectedDatabase: "postgres",
        expectedState: databaseStateExpectation(valid),
      }),
    ).toMatchObject({ latestMigration: "011", catalogValid: true });

    const missingLedgerTrigger: RestoredDatabaseEvidence = {
      ...valid,
      triggers: valid.triggers.filter(
        ({ triggerName }) =>
          triggerName !==
          "external_snapshot_byte_total_reconciliations_truncate_rejected",
      ),
    };
    expect(() =>
      assessRestoredDatabaseEvidence(missingLedgerTrigger, {
        expectedMigrations: missingLedgerTrigger.migrations,
        installationAccountId: accountId,
        expectedActiveApiKeys: 2,
        expectedDatabase: "postgres",
        expectedState: databaseStateExpectation(missingLedgerTrigger),
      }),
    ).toThrow(/restore validation/i);

    const nonDeferredProjection: RestoredDatabaseEvidence = {
      ...valid,
      triggers: valid.triggers.map((entry) =>
        entry.triggerName === "external_snapshot_byte_total_projection_valid"
          ? { ...entry, deferrable: false, initiallyDeferred: false }
          : entry,
      ),
    };
    expect(() =>
      assessRestoredDatabaseEvidence(nonDeferredProjection, {
        expectedMigrations: nonDeferredProjection.migrations,
        installationAccountId: accountId,
        expectedActiveApiKeys: 2,
        expectedDatabase: "postgres",
        expectedState: databaseStateExpectation(nonDeferredProjection),
      }),
    ).toThrow(/restore validation/i);
  });

  it("rejects the superseded classification-trigger function body after migration 010", () => {
    const accountId = randomUUID();
    const checksums = Array.from({ length: 10 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0"),
    );
    const valid = evidence({
      accountId,
      checksums,
      triggers: REQUIRED_TRIGGERS.slice(0, -3),
    });
    const superseded: RestoredDatabaseEvidence = {
      ...valid,
      triggers: valid.triggers.map((entry) =>
        entry.triggerName === "external_classification_transition_valid"
          ? {
              ...entry,
              functionBodySha256:
                "7e29bd82153cfd0976b925d2dd6a18879f3c9e16a4c79faf1586fdddb9aad718",
            }
          : entry,
      ),
    };

    expect(() =>
      assessRestoredDatabaseEvidence(superseded, {
        expectedMigrations: superseded.migrations,
        installationAccountId: accountId,
        expectedActiveApiKeys: 2,
        expectedDatabase: "postgres",
        expectedState: databaseStateExpectation(superseded),
      }),
    ).toThrow(/restore validation/i);
  });

  it.each([
    [
      "disabled trigger",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        triggers: value.triggers.map((entry) =>
          entry.triggerName ===
          "external_revision_classification_events_immutable"
            ? { ...entry, enabled: "disabled" as const }
            : entry,
        ),
      }),
    ],
    [
      "replacement trigger function",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        triggers: value.triggers.map((entry) =>
          entry.triggerName ===
          "external_revision_classification_events_immutable"
            ? { ...entry, functionName: "attacker_owned_trigger" }
            : entry,
        ),
      }),
    ],
    [
      "replacement trigger event",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        triggers: value.triggers.map((entry) =>
          entry.triggerName ===
          "external_revision_classification_events_immutable"
            ? { ...entry, events: ["INSERT"] as const }
            : entry,
        ),
      }),
    ],
    [
      "changed trigger function body",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        triggers: value.triggers.map((entry) =>
          entry.triggerName ===
          "external_revision_classification_events_immutable"
            ? { ...entry, functionBodySha256: "f".repeat(64) }
            : entry,
        ),
      }),
    ],
    [
      "missing migration-010 trigger",
      (value: RestoredDatabaseEvidence) => ({
        ...value,
        triggers: value.triggers.filter(
          ({ triggerName }) =>
            triggerName !== "external_revision_classification_events_immutable",
        ),
      }),
    ],
  ] as const)("rejects a restored database with a %s", (_name, corrupt) => {
    const accountId = randomUUID();
    const checksums = Array.from({ length: 10 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0"),
    );
    const valid = evidence({
      accountId,
      checksums,
      triggers: REQUIRED_TRIGGERS.slice(0, -3),
    });
    const corrupted = corrupt(valid);

    expect(() =>
      assessRestoredDatabaseEvidence(corrupted, {
        expectedMigrations: valid.migrations,
        installationAccountId: accountId,
        expectedActiveApiKeys: 2,
        expectedDatabase: "postgres",
        expectedState: databaseStateExpectation(valid),
      }),
    ).toThrow(/restore validation/i);
  });

  it("rejects canonical schema-control drift even when the live expectation is already drifted", () => {
    const accountId = randomUUID();
    const checksums = Array.from({ length: 10 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0"),
    );
    const valid = evidence({
      accountId,
      checksums,
      triggers: REQUIRED_TRIGGERS.slice(0, -3),
    });
    const drifted: RestoredDatabaseEvidence = {
      ...valid,
      triggers: valid.triggers.map((entry) =>
        entry.triggerName ===
        "external_revision_classification_events_immutable"
          ? {
              ...entry,
              functionDefinition: `${entry.functionDefinition}\n-- replaced`,
              functionBodySha256: "e".repeat(64),
            }
          : entry,
      ),
    };

    expect(() =>
      assessRestoredDatabaseEvidence(drifted, {
        expectedMigrations: drifted.migrations,
        installationAccountId: accountId,
        expectedActiveApiKeys: 2,
        expectedDatabase: "postgres",
        expectedState: databaseStateExpectation(drifted),
      }),
    ).toThrow(/restore validation/i);
  });

  it.each([
    [
      "constraint definition",
      (entry: RestoredDatabaseEvidence["constraints"][number]) => ({
        ...entry,
        definition: `${entry.definition} NOT VALID`,
      }),
    ],
    [
      "constraint table identity",
      (entry: RestoredDatabaseEvidence["constraints"][number]) => ({
        ...entry,
        tableName: "attacker_shadow_table",
      }),
    ],
    [
      "constraint validation state",
      (entry: RestoredDatabaseEvidence["constraints"][number]) => ({
        ...entry,
        validated: false,
      }),
    ],
  ] as const)("rejects restored %s drift", (_name, corrupt) => {
    const accountId = randomUUID();
    const checksum = "a".repeat(64);
    const valid = evidence({ accountId, checksums: [checksum] });
    const corrupted = {
      ...valid,
      constraints: valid.constraints.map((entry, index) =>
        index === 0 ? corrupt(entry) : entry,
      ),
    };

    expect(() =>
      assessRestoredDatabaseEvidence(corrupted, {
        expectedMigrations: valid.migrations,
        installationAccountId: accountId,
        expectedActiveApiKeys: 2,
        expectedDatabase: "postgres",
        expectedState: databaseStateExpectation(valid),
      }),
    ).toThrow(/restore validation/i);
  });

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
    expect(query).toContain("pg_get_constraintdef");
    expect(query).toContain("WHEN 't' THEN 'constraint-trigger'");
    expect(query).toContain("WHEN 'n' THEN 'not-null'");
    expect(query).toContain("constraint_entry.conrelid<>0");
    expect(query).toContain("external_revision_advisory_events");
    expect(query).toContain("external_content_objects");
    expect(query).toContain("repository_skill_usage");
    expect(query).toContain("pg_get_triggerdef");
    expect(query).toContain("pg_get_functiondef");
    expect(query).toContain("functionBodySha256");
    expect(query).toContain("tgenabled");
    expect(query).toContain("tgdeferrable");
    expect(query).toContain("tginitdeferred");
    expect(query).toContain("proname");
    expect(query).not.toMatch(/AS\s+(?:invariants|catalog|advisory)_valid/i);
  });
});
