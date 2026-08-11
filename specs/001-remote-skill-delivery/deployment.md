# Deployment and Operations Instructions

## Supported Topology

SkillWire is a stateless modular-monolith service backed by one authoritative PostgreSQL database.
One or more application instances may share that database because repository memory is always read
from and written to PostgreSQL directly. There is no repository-memory cache, invalidation protocol,
scope lock, or single-process deployment restriction.

```text
MCP client -> HTTPS edge -> SkillWire instance(s) -> authoritative PostgreSQL
                              |
                              +-> verified immutable catalog cache (instance-local)
```

The only application cache is the instance-local verified immutable catalog cache. Its entries are
addressed by immutable revision and verified hash, so application instances require no cache
coordination. Development Compose starts one SkillWire instance for convenience.

Database replicas, operator backups, snapshots, WAL archives, restore workflows, and physical-media
deletion are outside this feature and outside the `forget_repo_memory` API guarantee. SkillWire has
no credentials, configuration, commands, or readiness checks for those systems.

## Container Image

The Dockerfile must:

1. Pin a Node.js 24 LTS slim image by digest for release builds.
2. install with Corepack/pnpm and `--frozen-lockfile` in a build stage;
3. compile TypeScript 6 in strict mode and copy only runtime dependencies, compiled code, published
   catalog releases, the advisory chain, release metadata, and SQL migrations;
4. run as an unprivileged user with a read-only root filesystem and bounded temporary storage;
5. expose one application port and start only the SkillWire service; and
6. leave migrations, account/key administration, catalog administration, and manual audit cleanup
   as explicit operator commands rather than serving-entrypoint mutations.

`.dockerignore` excludes `.git`, secrets, local benchmark results, coverage, test temporary data,
editor state, dependency caches, and local databases. No API key, pepper, database credential, or
catalog publication staging directory enters an image layer.

## Docker Compose

`compose.yaml` contains:

- `postgres`: one authoritative PostgreSQL service with a named data volume and `pg_isready` health
  check;
- `migrate`: a one-shot `pnpm db:migrate` service after PostgreSQL is healthy; and
- `skillwire`: the application after migrations succeed.

PostgreSQL is not published outside the Compose network. SkillWire binds to `127.0.0.1:3000` in the
development profile. `compose.test.yaml` supplies an isolated test database and fixtures.
`compose.benchmark.yaml` fixes metadata and catalog-cache profiles for optional informational
measurement; it creates no performance gate.

## Configuration and Secrets

| Setting | Purpose | Secret |
|---------|---------|--------|
| `DATABASE_URL_FILE` | Authoritative PostgreSQL connection string. | Yes |
| `SKILLWIRE_API_KEY_PEPPER_FILE` | API-key HMAC pepper of at least 32 random bytes. | Yes |
| `SKILLWIRE_BIND_HOST` / `SKILLWIRE_PORT` | Bind address and port. | No |
| `SKILLWIRE_ALLOWED_HOSTS` | Explicit production `Host` allowlist. | No |
| `SKILLWIRE_CATALOG_ROOT` | Read-only root containing published catalog batches. | No |
| `SKILLWIRE_CATALOG_RELEASE` | Exact published catalog release identifier. | No |
| `SKILLWIRE_AUDIT_CLEANUP_INTERVAL_SECONDS` | `3600` in production; shorter only in tests. | No |
| `LOG_LEVEL` | Structured-log threshold. | No |

Secrets are mounted files supplied by the deployment secret store. Never place them in command-line
arguments or plaintext environment variables. There are deliberately no repository-cache, replica,
backup, WAL, restore, attestation, signing, high-water, or deletion-journal settings.

GitHub repository identity and token inputs are used only by the CI invocation of
`catalog:verify`; the serving service neither needs nor accepts them.

## SQL Migrations

Before starting a new image:

1. Run `pnpm db:migrate` as a one-shot job.
2. The runner takes a PostgreSQL advisory lock, verifies checksums of applied migrations, applies
   pending SQL transactionally, and exits nonzero on drift or failure.
3. Start application instances only after migration success.

Migrations are forward-only and immutable after application. Corrections use a new migration.

## Executable Catalog Administration

`src/catalog/admin-cli.ts` exposes exactly two subcommands, wired through package scripts:

```bash
pnpm catalog:publish   # tsx src/catalog/admin-cli.ts publish
pnpm catalog:verify    # tsx src/catalog/admin-cli.ts verify
```

`tsx` is a development dependency. `publish` is run only in a trusted maintainer workspace. It
validates the complete ten-skill launch inventory, instructions, declared resources, source and
published provenance, canonical bundles, resource hashes, advisory chain, and release metadata. It
then atomically creates and holds `catalog/releases/.publish-claim`, rescans all published revision
identities, creates the entire release in a sibling staging directory, and performs one
same-filesystem rename to the previously absent final release directory. Any existing/stale claim,
release path, or `(skillId, revision)` rejects the whole batch; no partial publication or overwrite
is allowed. Its structured result accounts for every proposed revision whether the batch is created
or rejected. A claim left by a crashed process is never reclaimed automatically; an operator must
first prove no publisher is active before removing that exact claim outside the CLI.

`verify` is strictly read-only. It verifies those same files and hashes without repairing,
normalizing, publishing, touching timestamps, or opening a database connection. Contract tests
instrument filesystem and database boundaries to demonstrate that it makes no writes.

## Advisory Baseline in GitHub Actions

For a non-genesis release, CI verification must:

1. fully paginate `GET /repos/{owner}/{repo}/releases?per_page=100`, retain releases with
   `draft: false` and valid `published_at` (including prereleases), and select the unique greatest
   publication timestamp; incomplete pagination or a tie fails closed;
2. resolve its tag reference and recursively peel any annotated tag objects to an exact lowercase
   40-character commit SHA;
3. require that SHA to equal `previousReleaseCommit` in the candidate release metadata;
4. retrieve the global `catalog/advisories.jsonl` at that exact commit through the GitHub Contents
   API; candidate release metadata is validated locally and no prior release-directory lookup is
   inferred; and
5. verify the candidate chain as an append-only extension of that exact prior chain.

CI fails closed when authentication, repository identity, pagination, an unambiguous selected
release, tag resolution, commit, candidate metadata, or prior advisory content is absent, invalid,
or unavailable.
It never substitutes `target_commitish`, a merge base, a branch name, or a fallback reference.

Genesis requires `genesis: true`, `previousReleaseCommit: null`, no local prior published batch, an
initial candidate advisory chain, and a successful fully paginated GitHub release-list check proving
that the repository has no non-draft release, including no prerelease. An API error or inaccessible
repository is not evidence that the list is empty.

The runtime service mounts the verified advisory chain and catalog releases read-only and exposes no
operation that edits them.

## Account and Key Operations

Run the out-of-band administration CLI in a one-shot container connected to PostgreSQL:

```text
pnpm admin account:create --id <uuid>
pnpm admin api-key:create --account <uuid>
pnpm admin api-key:rotate --key <uuid>
pnpm admin api-key:revoke --key <uuid>
pnpm admin api-key:list --account <uuid>
```

Create and rotate emit a secret once to explicitly selected secure output. Deploy the replacement,
verify it, and then revoke the old key. Authentication results are not cached, so revocation applies
to the next request.

## Repository Memory and Live Erasure

Every repository-memory operation queries the authoritative PostgreSQL database directly and scopes
data by `(account_id, repository_hash)`. `forget_repo_memory` performs one database transaction that
deletes matching usage rows and inserts the privacy-safe audit event. It returns the same success
shape whether rows existed, and a transaction failure returns `ERASURE_INCOMPLETE` without claiming
success.

There is no repository-memory cache to warm, bypass, inspect, or invalidate. After a successful
commit, later calls and server restarts cannot recover the deleted live rows. Logs, responses, and
deletion audit events contain no repository hash, skill identifier, outcome, query, usage detail, or
removed-count disclosure.

The API guarantee covers the authoritative live database only. Physical deletion from
operator-managed backups, WAL, snapshots, or storage media remains the deployment operator's
responsibility.

## Audit Expiration and Readiness

The database assigns `expires_at = created_at + interval '30 days'`. Every application audit query
includes `expires_at > database_now`, so expired events are always logically absent and never affect
behavior.

Startup performs the idempotent `expires_at <= database_now` deletion after database connectivity
and migrations but before `/health/ready` can succeed. Once ready, a scheduler executes the same
cleanup every hour. During continuous service and authoritative-database availability, physical
removal therefore occurs no later than one hour after expiration.

If the service or database is unavailable, SkillWire cannot guarantee physical deletion during that
interval. After either recovers, cleanup must complete before readiness is reported. Logical
expiration remains unconditional because all reads filter expired events. Cleanup logs contain only
aggregate operational status and never private event fields.

## Deployment Procedure

1. Build from a clean commit with frozen dependencies and record the image digest and catalog release
   identifier.
2. Require GitHub Actions formatting, type-aware lint, typecheck, unit, contract, integration,
   end-to-end, security, and evaluation jobs.
3. Run read-only `pnpm catalog:verify` with the authoritative GitHub release baseline and confirm the
   exact ten-skill batch and advisory-chain head.
4. Scan the final image and confirm there is no secret, client-write, downloaded-code execution,
   repository-memory cache, arbitrary fetch, backup, or restore capability.
5. Run migrations and start the desired number of stateless instances with mounted secrets and an
   explicit host allowlist.
6. Wait until startup audit cleanup completes and `/health/ready` succeeds.
7. Run authenticated search/load/resource, trust-field, no-client-write, memory, erasure, and tenant
   isolation smoke tests.
8. Route traffic.

An informational performance run may be recorded before or after deployment, but cannot change
acceptance or release status.

## GitHub Actions

`.github/workflows/ci.yml` uses pinned actions, frozen pnpm, and Linux jobs for:

- formatting checks;
- type-aware flat-config ESLint;
- strict TypeScript type checking;
- unit tests;
- MCP and catalog-CLI contract tests;
- PostgreSQL and composed-service integration tests;
- complete MCP end-to-end tests, including the no-client-write invariant;
- security tests; and
- frozen search and journey evaluation thresholds.

Catalog verification obtains least-privilege read access to GitHub release, tag/ref, and repository
contents data. CI validates benchmark fixture and report schemas without making timing assertions.

## Health, Logging, Cleanup, and Shutdown

- `/health/live` checks process responsiveness only.
- `/health/ready` requires database/schema health, successful startup audit cleanup, a running hourly
  cleanup scheduler, exact catalog publications, and verified release-anchored advisory integrity.
- SIGTERM rejects new requests, drains bounded in-flight operations, stops the cleanup scheduler,
  closes MCP contexts and the database pool, and flushes structured logs.
- Newline-delimited allowlisted structured logs go to stdout; privacy-safe audit events use their
  restricted database table.
- Alerts cover authentication/rate spikes, migration drift, catalog hash failures, advisory-chain
  failures, erasure failures, and missed or failed cleanup.

Health and logs expose no repository hash, raw API key, catalog content, or operator backup/WAL
detail.
