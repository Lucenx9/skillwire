# Deployment and operations

## Deployment sequence

1. Build `Dockerfile` from a clean commit with the frozen lockfile.
2. Run formatting, lint, typecheck, build, all six Vitest projects, catalog
   verification, advisory verification, and Compose validation.
3. Supply PostgreSQL URL and API-key pepper through mounted secret files.
4. Run the migration image as a one-shot job and require successful completion.
5. Start SkillWire with an explicit Host allowlist and read-only root
   filesystem.
6. Wait for `/health/ready`, which follows catalog verification, database
   connectivity, migrations, and startup expired-audit cleanup.
7. Bootstrap/rotate keys out of band and run the authenticated smoke journey.

The supported topology is one or more stateless SkillWire instances sharing one
authoritative PostgreSQL database. Do not add Redis, queues, repository-memory
replicas, or a second memory authority.

## Health and readiness

- `GET /health/live` reports process responsiveness only.
- `GET /health/ready` returns HTTP 200 only after startup cleanup succeeds;
  otherwise it returns 503 without protected details.
- An hourly cleanup failure makes readiness false. The next successful cleanup
  makes it ready again.

Compose waits for PostgreSQL health, then the migration job, then application
health. PostgreSQL is not published to the host.

## Shutdown and restart

SIGTERM and SIGINT stop new HTTP acceptance, close idle connections, drain
active requests up to `SKILLWIRE_SHUTDOWN_GRACE_MS`, stop the cleanup scheduler,
close the PostgreSQL pool, and emit one bounded lifecycle result. Compose grants
15 seconds before force termination.

Verify a release image with:

```bash
docker compose stop --timeout 15 skillwire
docker compose up --detach --wait --no-build skillwire
docker compose restart --timeout 15 skillwire
docker compose up --detach --wait --no-build skillwire
curl --fail http://127.0.0.1:3000/health/ready
```

Repository memory survives the restart because PostgreSQL is the only authority.

## Migrations

Migrations are forward-only and checksum protected. Run:

```bash
docker compose run --rm migrate
```

The runner serializes concurrent attempts with a PostgreSQL advisory lock and
exits nonzero on checksum drift. Never edit an applied migration; add a new
versioned migration.

## Troubleshooting

### Service never becomes ready

Check bounded container logs and PostgreSQL health. Common causes are a
missing/unreadable secret file, an invalid database URL, migration checksum
drift, an invalid catalog release/hash/advisory chain, a missing Host allowlist
for non-loopback binding, or failed startup audit cleanup. Fix the cause and
restart; do not bypass readiness.

### HTTP 401

Missing, malformed, unknown, expired, revoked keys and disabled accounts
deliberately share the same response. Verify the client secret source and use
the administration CLI to create a replacement; logs never reveal which
credential condition occurred.

### HTTP 403 or 429

403 usually means the request Host is absent from `SKILLWIRE_ALLOWED_HOSTS`.
Configure the exact edge/client host rather than accepting arbitrary values. 429
means the configured account or key token bucket is exhausted; honor
`Retry-After` rather than bypassing rate controls.

### Migration job fails

Confirm PostgreSQL connectivity and secret-file contents. A checksum drift
requires restoring the committed migration and creating a new migration for
corrections. Do not edit the migration table.

### Catalog verification fails

Keep traffic stopped. Run `catalog:verify` and `advisory:verify` from a clean
checkout. Never use publication as a repair path and never rewrite a published
revision.

### Audit cleanup fails

Readiness remains false. Restore authoritative database availability and let
startup cleanup finish. Expired events remain logically excluded from reads even
before physical cleanup. See [privacy boundaries](privacy.md) for availability
and backup limits.

## Informational benchmark

The benchmark is nonblocking. Bootstrap `.secrets/api-key`, then run separate
cold and warm processes. A cold run starts a fresh service process with zero
warmup operations; a warm run uses the frozen warmup count before recording:

```bash
chmod 0444 .secrets/api-key
trap 'chmod 0600 .secrets/api-key' EXIT
docker compose stop skillwire
SKILLWIRE_BENCHMARK_CACHE_STATE=catalog-cold \
SKILLWIRE_BENCHMARK_WARMUP=0 \
  docker compose -f compose.yaml -f compose.benchmark.yaml --profile benchmark up \
  --build --abort-on-container-exit benchmark
docker compose stop skillwire
SKILLWIRE_BENCHMARK_CACHE_STATE=catalog-warm \
SKILLWIRE_BENCHMARK_WARMUP=100 \
  docker compose -f compose.yaml -f compose.benchmark.yaml --profile benchmark up \
  --build --abort-on-container-exit benchmark
chmod 0600 .secrets/api-key
trap - EXIT
```

The temporary read-only mode lets the capability-dropped benchmark container
read the bind-mounted secret; the mode `0700` parent directory continues to
protect it on the host, and the trap restores mode `0600` on failure.

The Compose run prints completion totals and the raw-row hash. Running
`pnpm benchmark:informational` directly with the documented environment writes
the full report under ignored `benchmarks/results/`; it contains raw rows,
hashes, and observed percentiles. No timing value passes or fails release
readiness.
