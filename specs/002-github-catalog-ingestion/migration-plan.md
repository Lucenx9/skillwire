# Migration Plan: GitHub Catalog Ingestion

## Baseline

Feature 001 migrations `001` through `003` remain byte-for-byte unchanged. The existing migration
runner already applies checksum-protected files transactionally under a PostgreSQL advisory lock.
Feature 002 uses forward-only migrations `004` through `010`; existing migration files remain
frozen. Migration 010 adds a transactional classification baseline without rewriting candidate
history or immutable published content.

The existing `repository_skill_usage` table intentionally has no catalog foreign key, so imported
skill IDs and revisions work with repository memory without altering existing rows or account
isolation.

## Migration 004: Sources and Jobs

`migrations/004_github_sources_and_jobs.sql` creates:

- `github_sources`
- `github_source_aliases`
- `github_source_registrations`
- `github_discovery_runs`
- `github_discovery_evidence`
- `github_sync_runs`
- `github_job_leases`

It adds source-identity, alias, active-run, due-schedule, run-state, and lease-expiry indexes. All
tables are additive and unreferenced by the Feature 001 binary.

## Migration 005: Immutable External Catalog

`migrations/005_external_catalog_revisions.sql` creates:

- `external_source_snapshots`
- `external_skill_identities`
- `external_import_candidates`
- `external_content_objects`
- `external_skill_revisions`
- `external_revision_resources`
- `external_revision_dependencies`
- `external_snapshot_skill_observations`

It installs immutable-row triggers, content length/hash-format constraints, create-only revision
constraints, normalized-path uniqueness, and the indexes required by the PostgreSQL imported
provider. A deferred constraint or publication procedure validates same-source dependency targets
and resource/dependency count ceilings.

The source's nullable `current_published_snapshot_id` foreign key is added after snapshot creation to
avoid migration-order cycles.

## Migration 006: Verification, Classification, and Advisories

`migrations/006_external_policy_and_advisories.sql` creates:

- `external_verification_reports`
- `external_validation_findings`
- `external_classification_events`
- `external_current_classifications`
- `external_curation_decisions`
- `external_advisory_chain_head`
- `external_revision_advisory_events`

It installs immutable-row triggers, current-projection transition functions, and the serialized
external advisory append function. The advisory head is initialized to the documented external
genesis hash without modifying Feature 001's release-anchored chain.

## Migration 007: Convergence hardening

`migrations/007_feature_002_convergence.sql` adds immutable publication-time
owner/repository and legal-evidence fields, snapshot origin identity, durable
sync-run attempt/retry/summary fields, and immutable per-run quarantine results.
It preserves canonical provenance from stored revision bytes during its bounded
backfill and separates mutable aliases from published origin coordinates.

## Migration 010: Typed Revision Classification History

`migrations/010_revision_classification_events.sql` creates the dedicated append-only
`external_revision_classification_events` table and makes candidate and revision current projections
reference only events for the same subject and matching next classification. Existing immutable
candidate events and candidate-linked curation decisions are preserved unchanged.

The pre-010 schema did not identify which overloaded candidate events represented historical
revision transitions, so migration 010 does not invent a revision event chain. It records exactly one
`REVISION_CLASSIFICATION_BACKFILLED` baseline per existing revision current projection at that
projection's current classification. Its `created_at` is the migration transaction timestamp, not a
fabricated historical timestamp, and its report reference is null. All later revision history is
fully typed and continuous from that baseline. A deterministic baseline identity plus trigger
validation prevents another baseline after migration. The baseline's initiating-candidate
attribution is the candidate referenced by the legacy current projection event; it does not claim
that candidate performed a historical revision transition.

## Deployment Order

1. Stop traffic and drain every application, synchronization, and administration writer while
   leaving PostgreSQL running.
2. Take and validate the operator-supported pre-010 PostgreSQL backup.
3. Apply migrations 001--010 with the new image's `pnpm db:migrate` under bounded lock and statement
   timeouts.
4. Rerun the migrator to verify `schema_migrations` checksums, then verify catalog and advisory
   integrity from the same release image.
5. Start only the post-010 binary. It keeps readiness false until its newer-schema check, migrations,
   audit cleanup, active PostgreSQL probe, imported-catalog integrity probe, and scheduler
   initialization succeed.
6. Require readiness before reopening traffic. Leave source synchronization disabled until operator
   GitHub configuration is validated.

Migration 010 explicitly locks the candidate projection, candidate event history, and candidate
curation decisions before the shared revision projection. Its DDL, baseline, constraints, and
migration registration commit atomically; no application can observe a half-backfilled schema.

## Compatibility and Rollback

- Feature 001 data remains compatible, but the maintenance window deliberately stops all reads and
  writers while migration 010 changes the event-reference contract. A pre-010 binary must never run
  against schema 010.
- The migration runner rejects a database whose registered migration version is newer than its
  bundled directory. This protects post-010 binaries during future rollback; pre-010 binaries did
  not have the guard and are prohibited operationally after 010.
- A failed migration-010 transaction leaves schema 009 registered and usable by the pre-010
  application. After 010 succeeds, an image-only rollback across the boundary is unsafe and
  prohibited. Full rollback stops writers and restores the pre-010 database backup together with
  the matching old image.
- If publication fails, the transaction leaves `current_published_snapshot_id` unchanged. No data
  cleanup is required to restore the prior visible catalog.
- If migration application fails, the per-file transaction rolls back and the application never
  becomes ready.
- Runtime revocation of ingestion privileges or scheduler disablement does not affect Feature 001 or
  already published imported reads.

## Data Evolution Rules

- Do not backfill first-party catalog releases into PostgreSQL.
- Do not rewrite canonical schema v1. External schema v2 serializers and verifiers coexist.
- Never amend applied migration files. Constraint or index changes use migration `007` or later.
- Never delete source history or published revisions when a source is unregistered, renamed,
  transferred, private, or removed. Current availability changes through source state and advisory
  events.
- Content deduplication is opportunistic on insertion and must compare full stored bytes after a
  conflict; it is not a post-deployment destructive compaction.

## Migration Verification

Required integration coverage:

1. Empty-database application of `001` through `010`.
2. Upgrade from a real `001` through `003` fixture with accounts, keys, memory, and erasure audit
   rows preserved exactly.
3. Concurrent migration runners and checksum-drift rejection.
4. Feature 001 binary/read queries against the upgraded schema.
5. Required indexes, constraints, trigger immutability, runtime privilege boundaries, and advisory
   genesis integrity.
6. Failed migration transaction recovery followed by a successful rerun.
7. Repeated migration command idempotence.
8. Populated schema-009 upgrade coverage for verified, quarantined, curated, and shared-sibling
   revision projections, including truthful transaction-time baselines and malformed-history
   rollback.
9. Newer-schema rejection plus bounded forgotten-writer lock and statement timeout recovery.
