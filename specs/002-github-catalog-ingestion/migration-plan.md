# Migration Plan: GitHub Catalog Ingestion

## Baseline

Feature 001 migrations `001` through `003` remain byte-for-byte unchanged. The existing migration
runner already applies checksum-protected files transactionally under a PostgreSQL advisory lock.
Feature 002 adds four forward-only migrations and no destructive backfill.

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

## Deployment Order

1. Back up PostgreSQL according to the existing database backup boundary.
2. Apply migrations with the new image's `pnpm db:migrate` before application readiness.
3. Verify `schema_migrations` checksums and explicit access to all new tables/functions.
4. Start the new binary. It keeps readiness false until migrations, existing audit cleanup, active
   PostgreSQL probe, imported-catalog integrity probe, and scheduler initialization succeed.
5. Leave source synchronization disabled until operator GitHub configuration is validated.
6. Enable ingestion and register the acceptance fixture/source. Existing Feature 001 search/load is
   continuously available during this rollout.

## Compatibility and Rollback

- The previous Feature 001 binary can run against the upgraded database because migrations add only
  new tables/functions and no existing column, constraint, or behavior changes.
- A failed deployment rolls back the application image, not the schema. New tables remain dormant;
  forward-only migrations are not reversed in production.
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

1. Empty-database application of `001` through `007`.
2. Upgrade from a real `001` through `003` fixture with accounts, keys, memory, and erasure audit
   rows preserved exactly.
3. Concurrent migration runners and checksum-drift rejection.
4. Feature 001 binary/read queries against the upgraded schema.
5. Required indexes, constraints, trigger immutability, runtime privilege boundaries, and advisory
   genesis integrity.
6. Failed migration transaction recovery followed by a successful rerun.
7. Repeated migration command idempotence.
