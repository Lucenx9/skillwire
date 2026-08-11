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

The full benchmark is nonblocking and runs only from the manually dispatched
`informational-benchmark` workflow (or the equivalent local profile). Each cache
state uses a distinct Compose project and disposable PostgreSQL volume. The
runner erases its deterministic per-client repository scopes before warmup and
again before measurement.

`catalog-cold` disables catalog retention and re-verifies the immutable release
for every search, load, and resource operation. `catalog-warm` preloads the same
verified release. Both modes use the same 100 unmeasured warmup operations;
warmup does not turn the cold mode into a retained cache.

For a local run, start a disposable stack, then export its exact environment
metadata before invoking the benchmark container:

```bash
export SKILLWIRE_BENCHMARK_COMMIT="$(git rev-parse HEAD)"
export SKILLWIRE_BENCHMARK_DOCKER_VERSION="$(docker version --format '{{.Server.Version}}')"
export SKILLWIRE_BENCHMARK_COMPOSE_VERSION="$(docker compose version --short)"
export SKILLWIRE_BENCHMARK_SKILLWIRE_IMAGE_DIGEST="$(docker image inspect skillwire:local --format '{{.Id}}')"
export SKILLWIRE_BENCHMARK_POSTGRES_IMAGE_DIGEST="$(docker inspect "$(docker compose ps -q postgres)" --format '{{.Image}}')"
export SKILLWIRE_BENCHMARK_CLIENT_IMAGE_DIGEST="$(docker image inspect skillwire-benchmark:local --format '{{.Id}}')"
export SKILLWIRE_BENCHMARK_UID="$(id -u)"
export SKILLWIRE_BENCHMARK_GID="$(id -g)"
chmod 0444 .secrets/api-key
trap 'chmod 0600 .secrets/api-key' EXIT
SKILLWIRE_BENCHMARK_CACHE_STATE=catalog-cold \
SKILLWIRE_BENCHMARK_WARMUP=100 \
  docker compose -f compose.yaml -f compose.benchmark.yaml --profile benchmark up \
  --build --abort-on-container-exit benchmark
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

The manual workflow sets this metadata automatically, uses a fresh Compose
project and volume for each mode, and uploads the complete cold/warm reports as
an informational artifact. Required CI runs only schema validation and a
100-operation functional smoke mix; it does not run the full benchmark.

The Compose run prints completion totals and the raw-row hash. Running
`pnpm benchmark:informational` directly with the documented environment writes
the full report under ignored `benchmarks/results/`; it contains raw rows,
hashes, and observed percentiles. No timing value passes or fails release
readiness.
