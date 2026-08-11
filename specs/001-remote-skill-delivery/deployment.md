# Deployment Instructions: Remote Skill Delivery MVP

## Supported Topology

The MVP deployment is one SkillWire container and one PostgreSQL 18 container or managed database.
The MCP transport is stateless, but repository memory and API-key state are durable in PostgreSQL.
The supported application scale is one instance; there is no Redis, queue, pub/sub, session router,
worker service, or frontend.

```text
MCP client ── HTTPS proxy/load balancer ── SkillWire container ── PostgreSQL 18
```

TLS terminates before SkillWire in production. The Compose development profile binds SkillWire to
loopback over HTTP and is not a public production edge.

## Container Image

The implementation Dockerfile must:

1. Use a pinned Node.js 24 LTS slim image.
2. Install dependencies with Corepack/pnpm and `--frozen-lockfile` in a build stage.
3. Run typecheck/tests outside the runtime layer, compile strict TypeScript, and prune dev
   dependencies.
4. Copy compiled code, production dependencies, version-controlled catalog, and SQL migrations into
   a minimal runtime stage.
5. Run as an unprivileged user with a read-only application/catalog filesystem and a writable
   temporary directory only if Node requires it.
6. Expose one application port and define a liveness health check.
7. Start only the service process; migrations run as a separate one-shot command.

`.dockerignore` must exclude `.git`, local environment files, test output, coverage, editor state,
temporary keys, and dependency caches. No bearer token, pepper, or database credential is baked into
an image layer.

## Compose Services

`compose.yaml` contains exactly:

- `postgres`: PostgreSQL 18 with a named data volume and `pg_isready` health check.
- `migrate`: the SkillWire image running `pnpm db:migrate` after PostgreSQL is healthy; exits zero on
  a compatible fully migrated schema.
- `skillwire`: the same image running the service after `migrate` completed successfully.

The Compose file uses health conditions for startup ordering. PostgreSQL is not published outside
the Compose network. SkillWire is bound to `127.0.0.1:3000` by default.

## Configuration and Secrets

Required configuration:

| Setting | Purpose | Secret |
|---------|---------|--------|
| `DATABASE_URL_FILE` | Mounted file containing the PostgreSQL connection string. | Yes |
| `SKILLWIRE_API_KEY_PEPPER_FILE` | Mounted file containing at least 32 random bytes. | Yes |
| `SKILLWIRE_AUDIT_PEPPER_FILE` | Separate mounted key for non-reversible repository correlations. | Yes |
| `SKILLWIRE_BIND_HOST` | Bind address; `127.0.0.1` locally, `0.0.0.0` in container. | No |
| `SKILLWIRE_PORT` | Service port, default 3000. | No |
| `SKILLWIRE_ALLOWED_HOSTS` | Explicit comma-separated production Host allowlist. | No |
| `LOG_LEVEL` | Structured log threshold. | No |

Compose secrets mount database and pepper values as files. Production may use the platform secret
store, but the application reads the same file paths. `_FILE` is preferred to plaintext environment
values because environment values are easily exposed by process inspection and diagnostics.

The fixed request/content/rate limits are versioned application policy in the MVP and are not
deployment-tunable.

## Database Migration

Before starting a new image:

1. Back up PostgreSQL.
2. Run the image's one-shot `pnpm db:migrate` command.
3. The runner takes its advisory lock, verifies checksums for every applied migration, applies pending
   SQL transactions, and exits nonzero on any drift or failure.
4. Start SkillWire only after successful migration.

Migrations are forward-only. Rollback means restoring the prior compatible database backup or
deploying a new corrective migration; applied SQL files are never edited. Application changes must
remain compatible with the migration ordering described in the release notes.

## Account and Key Operations

Run the operator CLI inside a one-off container connected to PostgreSQL:

```text
pnpm admin account:create --id <uuid>
pnpm admin api-key:create --account <uuid>
pnpm admin api-key:rotate --key <uuid>
pnpm admin api-key:revoke --key <uuid>
pnpm admin api-key:list --account <uuid>
```

Key creation/rotation emits a secret once to an explicitly selected secure output. Rotation does not
revoke the old key automatically: deploy the replacement to the client, verify it, then revoke the
old key. Revocation is effective on the next request. Never pass a bearer secret as a CLI argument.

## Deployment Procedure

1. Build the image from a clean commit and locked dependencies.
2. Run typecheck plus unit, contract, integration, end-to-end, and security suites.
3. Scan the final image and produce its digest.
4. Back up PostgreSQL and run the one-shot migration using the new image.
5. Start one SkillWire instance with read-only root filesystem, mounted secrets, and allowed hosts.
6. Wait for `/health/ready`; it verifies database connectivity, migration compatibility, and catalog
   integrity without exposing catalog or account details.
7. Run the quickstart search/load/resource and tenant-isolation smoke tests.
8. Route traffic to the instance and retain the prior image for rollback.

## Health and Shutdown

- `/health/live` checks process event-loop responsiveness only.
- `/health/ready` checks PostgreSQL, schema version, and verified catalog availability with a short
  timeout. It does not authenticate or expose internal identifiers.
- On SIGTERM, stop accepting requests, allow bounded in-flight calls to finish, close per-request MCP
  contexts and the PostgreSQL pool, flush structured logs, and exit before the platform grace period.

## Logs, Backups, and Recovery

- Emit newline-delimited Pino JSON to stdout; the deployment platform owns retention and access.
- Apply the allowlist/redaction rules in [security.md](./security.md) before serialization.
- Alert operationally on readiness failure, repeated auth rejection, rate limiting, migration drift,
  catalog verification failure, and revision-unavailable errors.
- Back up PostgreSQL on a schedule appropriate to repository-memory recovery and test restoration.
- The catalog is recovered from the deployed commit/image and reverified at startup; it is not backed
  up from runtime cache.

## Scaling Boundary

Do not add a second SkillWire instance under this plan. The transport is stateless and PostgreSQL is
shareable, but the MVP rate limiter and verified cache are process-local. Horizontal scaling requires
a separate specification for global rate semantics, cache behavior, capacity tests, and deployment
coordination. That future work must not introduce sessions, queues, Redis, or microservices without
its own constitution-compliant amendment/specification.
