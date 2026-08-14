import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { verifyExternalAdvisoryChain } from "../../../domain/external-catalog/external-advisory-chain.js";
import {
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "../process/command-runner.js";
import { dockerProcessEnvironment } from "../docker/environment.js";

const MigrationSchema = z.object({
  version: z.string().regex(/^\d{3}$/),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface ExpectedMigration {
  readonly version: string;
  readonly checksum: string;
}

const AdvisoryEventSchema = z.object({
  sequence: z.string().regex(/^[1-9]\d*$/),
  previousEventSha256: z.string().regex(/^[0-9a-f]{64}$/),
  revisionId: z.uuid(),
  kind: z.enum(["availability", "security"]),
  status: z.enum(["available", "unavailable", "revoked"]),
  reasonCode: z.string().min(1).max(80),
  effectiveAt: z.iso.datetime({ offset: true }),
  eventSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const EvidenceSchema = z.object({
  currentDatabase: z.string(),
  inRecovery: z.boolean(),
  transactionReadOnly: z.string(),
  migrations: z.array(MigrationSchema).max(999),
  constraints: z.array(z.string().min(1).max(128)).max(4096),
  triggers: z.array(z.string().min(1).max(128)).max(4096),
  catalog: z.object({
    snapshotCount: z.number().int().nonnegative(),
    revisionCount: z.number().int().nonnegative(),
    resourceCount: z.number().int().nonnegative(),
    dependencyCount: z.number().int().nonnegative(),
    contentObjectCount: z.number().int().nonnegative(),
    identitySha256: z.string().regex(/^[0-9a-f]{64}$/),
    invalidSnapshotCounts: z.number().int().nonnegative(),
    invalidPublishedPointers: z.number().int().nonnegative(),
    invalidContentLengths: z.number().int().nonnegative(),
    invalidContentHashes: z.number().int().nonnegative(),
    invalidSnapshotAdvisoryHeads: z.number().int().nonnegative(),
  }),
  advisory: z.object({
    lastSequence: z.string().regex(/^\d+$/),
    lastEventSha256: z.string().regex(/^[0-9a-f]{64}$/),
    events: z.array(AdvisoryEventSchema).max(100_000),
  }),
  authoritativeState: z.object({
    installationAccountStatus: z.enum(["active", "disabled"]).nullable(),
    activeApiKeyCount: z.number().int().nonnegative(),
    repositoryUsageRows: z.number().int().nonnegative(),
    repositoryErasureRows: z.number().int().nonnegative(),
  }),
});

export type RestoredDatabaseEvidence = z.infer<typeof EvidenceSchema>;

export interface DatabaseStateExpectation {
  readonly catalog: {
    readonly snapshotCount: number;
    readonly revisionCount: number;
    readonly resourceCount: number;
    readonly dependencyCount: number;
    readonly contentObjectCount: number;
    readonly identitySha256: string;
  };
  readonly advisory: {
    readonly lastSequence: string;
    readonly lastEventSha256: string;
  };
  readonly authoritativeState: RestoredDatabaseEvidence["authoritativeState"];
}

export interface RestoredDatabaseValidation {
  readonly latestMigration: string;
  readonly migrationInventoryValid: boolean;
  readonly constraintsValid: boolean;
  readonly catalogValid: boolean;
  readonly advisoryValid: boolean;
  readonly authoritativeStateValid: boolean;
  readonly ready: boolean;
}

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
] as const;

const REQUIRED_TRIGGERS = [
  "external_advisory_append_valid",
  "external_advisory_events_immutable",
  "external_dependencies_immutable",
  "external_resources_immutable",
  "external_revisions_immutable",
  "external_snapshots_immutable",
] as const;

export async function expectedMigrationInventory(
  directory: string,
  latestMigration: string,
): Promise<readonly ExpectedMigration[]> {
  if (!/^\d{3}$/.test(latestMigration) || latestMigration === "000")
    throw new Error("Expected latest migration identity is invalid");
  const resolvedDirectory = resolve(directory);
  const directoryHandle = await open(
    resolvedDirectory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    throw new Error("Expected migration directory is unsafe", {
      cause: error,
    });
  });
  try {
    const directoryStats = await directoryHandle.stat();
    if (
      !directoryStats.isDirectory() ||
      directoryStats.uid !== process.getuid?.() ||
      (directoryStats.mode & 0o022) !== 0
    )
      throw new Error("Expected migration directory is unsafe");
    const names = (await readdir(resolvedDirectory))
      .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
      .filter((name) => name.slice(0, 3) <= latestMigration)
      .toSorted();
    const expectedVersions = Array.from(
      { length: Number(latestMigration) },
      (_, index) => String(index + 1).padStart(3, "0"),
    );
    if (
      names.length !== expectedVersions.length ||
      names.some((name, index) => name.slice(0, 3) !== expectedVersions[index])
    )
      throw new Error(
        "Expected migration inventory is incomplete or ambiguous",
      );
    return await Promise.all(
      names.map(async (name) => {
        const handle = await open(
          resolve(directory, name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stats = await handle.stat();
          if (!stats.isFile() || stats.nlink !== 1)
            throw new Error(
              "Expected migration is not a protected regular file",
            );
          return {
            version: name.slice(0, 3),
            checksum: createHash("sha256")
              .update(await handle.readFile())
              .digest("hex"),
          };
        } finally {
          await handle.close();
        }
      }),
    );
  } finally {
    await directoryHandle.close();
  }
}

export function assessRestoredDatabaseEvidence(
  input: unknown,
  expectations: {
    readonly expectedMigrations: readonly ExpectedMigration[];
    readonly installationAccountId: string;
    readonly expectedActiveApiKeys: number;
    readonly expectedDatabase: "postgres" | "skillwire";
    readonly expectedState: DatabaseStateExpectation;
  },
): RestoredDatabaseValidation {
  z.uuid().parse(expectations.installationAccountId);
  if (
    !Number.isInteger(expectations.expectedActiveApiKeys) ||
    expectations.expectedActiveApiKeys < 0
  )
    throw new Error("Restore validation expectation is invalid");
  const evidence = EvidenceSchema.parse(input);
  const expectedMigrations = z
    .array(MigrationSchema)
    .parse(expectations.expectedMigrations);
  if (
    expectedMigrations.length === 0 ||
    JSON.stringify(evidence.migrations) !== JSON.stringify(expectedMigrations)
  )
    throw new Error("Restored migration inventory or checksum is invalid");
  const constraints = new Set(evidence.constraints);
  const triggers = new Set(evidence.triggers);
  const constraintsValid = REQUIRED_CONSTRAINTS.every((name) =>
    constraints.has(name),
  );
  const triggersValid = REQUIRED_TRIGGERS.every((name) => triggers.has(name));
  const catalogValid =
    evidence.catalog.invalidSnapshotCounts === 0 &&
    evidence.catalog.invalidPublishedPointers === 0 &&
    evidence.catalog.invalidContentLengths === 0 &&
    evidence.catalog.invalidContentHashes === 0 &&
    evidence.catalog.invalidSnapshotAdvisoryHeads === 0 &&
    evidence.catalog.snapshotCount ===
      expectations.expectedState.catalog.snapshotCount &&
    evidence.catalog.revisionCount ===
      expectations.expectedState.catalog.revisionCount &&
    evidence.catalog.resourceCount ===
      expectations.expectedState.catalog.resourceCount &&
    evidence.catalog.dependencyCount ===
      expectations.expectedState.catalog.dependencyCount &&
    evidence.catalog.contentObjectCount ===
      expectations.expectedState.catalog.contentObjectCount &&
    evidence.catalog.identitySha256 ===
      expectations.expectedState.catalog.identitySha256;
  let advisoryValid: boolean;
  try {
    verifyExternalAdvisoryChain(
      evidence.advisory.events,
      evidence.advisory.lastEventSha256,
    );
    advisoryValid =
      evidence.advisory.lastSequence ===
        String(evidence.advisory.events.length) &&
      evidence.advisory.lastSequence ===
        expectations.expectedState.advisory.lastSequence &&
      evidence.advisory.lastEventSha256 ===
        expectations.expectedState.advisory.lastEventSha256;
  } catch {
    advisoryValid = false;
  }
  const authoritativeStateValid =
    evidence.authoritativeState.installationAccountStatus === "active" &&
    evidence.authoritativeState.activeApiKeyCount ===
      expectations.expectedActiveApiKeys &&
    JSON.stringify(evidence.authoritativeState) ===
      JSON.stringify(expectations.expectedState.authoritativeState);
  const ready =
    evidence.currentDatabase === expectations.expectedDatabase &&
    !evidence.inRecovery &&
    evidence.transactionReadOnly === "off";
  if (
    !constraintsValid ||
    !triggersValid ||
    !catalogValid ||
    !advisoryValid ||
    !authoritativeStateValid ||
    !ready
  )
    throw new Error("Restored database failed production restore validation");
  return {
    latestMigration: expectedMigrations.at(-1)?.version ?? "",
    migrationInventoryValid: true,
    constraintsValid: true,
    catalogValid: true,
    advisoryValid: true,
    authoritativeStateValid: true,
    ready: true,
  };
}

export function databaseStateExpectation(
  input: unknown,
): DatabaseStateExpectation {
  const evidence = EvidenceSchema.parse(input);
  return {
    catalog: {
      snapshotCount: evidence.catalog.snapshotCount,
      revisionCount: evidence.catalog.revisionCount,
      resourceCount: evidence.catalog.resourceCount,
      dependencyCount: evidence.catalog.dependencyCount,
      contentObjectCount: evidence.catalog.contentObjectCount,
      identitySha256: evidence.catalog.identitySha256,
    },
    advisory: {
      lastSequence: evidence.advisory.lastSequence,
      lastEventSha256: evidence.advisory.lastEventSha256,
    },
    authoritativeState: evidence.authoritativeState,
  };
}

function restoredDatabaseEvidenceQuery(installationAccountId: string): string {
  const accountId = z.uuid().parse(installationAccountId);
  return `SELECT json_build_object(
    'currentDatabase', current_database(),
    'inRecovery', pg_is_in_recovery(),
    'transactionReadOnly', current_setting('transaction_read_only'),
    'migrations', (SELECT COALESCE(json_agg(json_build_object('version',version,'checksum',checksum) ORDER BY version),'[]'::json) FROM schema_migrations),
    'constraints', (SELECT COALESCE(json_agg(conname ORDER BY conname),'[]'::json) FROM pg_constraint JOIN pg_namespace ON pg_namespace.oid=pg_constraint.connamespace WHERE nspname='public'),
    'triggers', (SELECT COALESCE(json_agg(tgname ORDER BY tgname),'[]'::json) FROM pg_trigger JOIN pg_class ON pg_class.oid=pg_trigger.tgrelid JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace WHERE nspname='public' AND NOT tgisinternal),
    'catalog', json_build_object(
      'snapshotCount', (SELECT count(*) FROM external_source_snapshots),
      'revisionCount', (SELECT count(*) FROM external_skill_revisions),
      'resourceCount', (SELECT count(*) FROM external_revision_resources),
      'dependencyCount', (SELECT count(*) FROM external_revision_dependencies),
      'contentObjectCount', (SELECT count(*) FROM external_content_objects),
      'identitySha256', (SELECT encode(sha256(convert_to(COALESCE(string_agg(identity,'\n' ORDER BY identity),''),'UTF8')),'hex') FROM (SELECT 'snapshot:'||id::text||':'||source_id::text||':'||commit_sha||':'||tree_sha||':'||COALESCE(advisory_chain_head_sha256,'null') AS identity FROM external_source_snapshots UNION ALL SELECT 'revision:'||id::text||':'||snapshot_id::text||':'||bundle_sha256||':'||content_identity_sha256 FROM external_skill_revisions UNION ALL SELECT 'resource:'||revision_id::text||':'||resource_path||':'||content_sha256 FROM external_revision_resources UNION ALL SELECT 'dependency:'||revision_id::text||':'||target_revision_id::text||':'||evidence_source_sha256 FROM external_revision_dependencies UNION ALL SELECT 'content:'||sha256||':'||byte_length::text FROM external_content_objects) catalog_identity),
      'invalidSnapshotCounts', (SELECT count(*) FROM external_source_snapshots snapshot WHERE snapshot.revision_count<>(SELECT count(*) FROM external_skill_revisions revision WHERE revision.snapshot_id=snapshot.id) OR snapshot.candidate_count<>(SELECT count(*) FROM external_import_candidates candidate WHERE candidate.snapshot_id=snapshot.id) OR snapshot.quarantine_count<>(SELECT count(*) FROM external_import_candidates candidate JOIN external_current_classifications current ON current.candidate_id=candidate.id WHERE candidate.snapshot_id=snapshot.id AND current.classification='quarantined') OR snapshot.resource_count<>(SELECT count(*) FROM external_revision_resources resource JOIN external_skill_revisions revision ON revision.id=resource.revision_id WHERE revision.snapshot_id=snapshot.id) OR snapshot.dependency_count<>(SELECT count(*) FROM external_revision_dependencies dependency JOIN external_skill_revisions revision ON revision.id=dependency.revision_id WHERE revision.snapshot_id=snapshot.id) OR snapshot.decoded_bytes<>(SELECT COALESCE(sum(octet_length(revision.canonical_bytes)),0) FROM external_skill_revisions revision WHERE revision.snapshot_id=snapshot.id)),
      'invalidPublishedPointers', (SELECT count(*) FROM github_sources source JOIN external_source_snapshots snapshot ON snapshot.id=source.current_published_snapshot_id WHERE snapshot.source_id<>source.id),
      'invalidContentLengths', (SELECT count(*) FROM external_content_objects WHERE byte_length<>octet_length(content)),
      'invalidContentHashes', (SELECT count(*) FROM external_content_objects WHERE sha256<>encode(sha256(convert_to(content,'UTF8')),'hex')),
      'invalidSnapshotAdvisoryHeads', (SELECT count(*) FROM external_source_snapshots snapshot WHERE snapshot.advisory_chain_head_sha256 IS NULL OR (snapshot.advisory_chain_head_sha256<>repeat('0',64) AND NOT EXISTS (SELECT 1 FROM external_revision_advisory_events event WHERE event.event_sha256=snapshot.advisory_chain_head_sha256)))
    ),
    'advisory', json_build_object(
      'lastSequence', (SELECT last_sequence::text FROM external_advisory_chain_head WHERE singleton),
      'lastEventSha256', (SELECT last_event_sha256 FROM external_advisory_chain_head WHERE singleton),
      'events', (SELECT COALESCE(json_agg(json_build_object('sequence',sequence::text,'previousEventSha256',previous_event_sha256,'revisionId',revision_id::text,'kind',advisory_kind,'status',advisory_status,'reasonCode',reason_code,'effectiveAt',to_char(effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'eventSha256',event_sha256) ORDER BY sequence),'[]'::json) FROM external_revision_advisory_events)
    ),
    'authoritativeState', json_build_object(
      'installationAccountStatus', (SELECT status FROM accounts WHERE id='${accountId}'::uuid),
      'activeApiKeyCount', (SELECT count(*) FROM api_keys WHERE account_id='${accountId}'::uuid AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>statement_timestamp())),
      'repositoryUsageRows', (SELECT count(*) FROM repository_skill_usage WHERE account_id='${accountId}'::uuid),
      'repositoryErasureRows', (SELECT count(*) FROM repository_erasure_audit WHERE account_id='${accountId}'::uuid)
    )
  )::text`;
}

export async function validateRestoredDatabaseContainer(options: {
  readonly dockerExecutable: string;
  readonly containerName: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly expectedMigrations: readonly ExpectedMigration[];
  readonly installationAccountId: string;
  readonly expectedActiveApiKeys: number;
  readonly expectedState: DatabaseStateExpectation;
  readonly run?:
    ((options: CommandOptions) => Promise<CommandResult>) | undefined;
}): Promise<RestoredDatabaseValidation> {
  if (!/^skillwire-backup-validate-[0-9a-f]{16}$/.test(options.containerName))
    throw new Error("Restore-validation container identity is invalid");
  const evidence = await readDatabaseEvidence({
    dockerExecutable: options.dockerExecutable,
    dockerArgs: ["exec", options.containerName],
    databaseName: "postgres",
    databaseUser: "postgres",
    environment: options.environment,
    signal: options.signal,
    installationAccountId: options.installationAccountId,
    run: options.run,
  });
  return assessRestoredDatabaseEvidence(evidence, {
    ...options,
    expectedDatabase: "postgres",
  });
}

export async function readDatabaseEvidence(options: {
  readonly dockerExecutable: string;
  readonly dockerArgs: readonly string[];
  readonly databaseName: "postgres" | "skillwire";
  readonly databaseUser: "postgres" | "skillwire";
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly installationAccountId: string;
  readonly run?:
    ((options: CommandOptions) => Promise<CommandResult>) | undefined;
}): Promise<RestoredDatabaseEvidence> {
  const result = await (options.run ?? runCommand)({
    executable: resolve(options.dockerExecutable),
    args: [
      ...options.dockerArgs,
      "psql",
      `--username=${options.databaseUser}`,
      `--dbname=${options.databaseName}`,
      "--tuples-only",
      "--no-align",
      "--set=ON_ERROR_STOP=1",
      "--command",
      restoredDatabaseEvidenceQuery(options.installationAccountId),
    ],
    environment: dockerProcessEnvironment(options.environment),
    deadlineMilliseconds: 30_000,
    maximumOutputBytes: 16 * 1024 * 1024,
    signal: options.signal,
  });
  let evidence: unknown;
  try {
    evidence = JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    throw new Error("Restored database returned malformed validation evidence");
  }
  return EvidenceSchema.parse(evidence);
}
