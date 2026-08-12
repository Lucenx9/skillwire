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

Optional GitHub discovery is disabled unless
`SKILLWIRE_GITHUB_INGESTION_ENABLED=true` and a token is supplied. Configure its
cadence and budgets from `.env.example`; see
[source administration](source-administration.md).

The supported topology is one or more stateless SkillWire instances sharing one
authoritative PostgreSQL database. Do not add Redis, queues, repository-memory
replicas, or a second memory authority.

## Autonomous-activation rollout and compatibility

Feature 003 is an additive metadata rollout. Each server instance constructs the
existing `McpServer` with the centralized `skillwire-activation-v1` instruction
value. The official SDK publishes that same value through MCP 2025-11-25
`initialize` and MCP 2026-07-28 `server/discover`. Tool names, titles, inputs,
outputs, authentication, tenancy, rate limits, and the stateless HTTP transport
remain unchanged; descriptions and standard annotations are advisory additions.

Deploy normally, then run `pnpm test:activation` and inspect both protocol
metadata tests before shifting traffic. Mixed old/new instances are safe for
existing callers, although autonomous behavior may vary until every instance
publishes the policy. Clients that ignore instructions continue using the
ordinary six-tool surface. No client configuration migration, repository file,
installed skill, UI behavior, or database migration is part of rollout.

Rollback the application image to the preceding release if metadata causes an
unacceptable harness regression. Existing repository-memory and imported-catalog
rows remain compatible. Do not edit old migrations or delete memory to roll back
instructions. A rollback removes the new hints; it cannot and need not undo
client writes because SkillWire has no client-write capability.

The server is stateless per POST and cannot enforce once-per-task search,
local-skill precedence, conversational intent, or fail-open continuation across
calls. It enforces each supplied operation independently. Unavailable service,
authentication failure, rate limiting, request timeout, empty search,
unavailable revision, memory failure, and resource failure retain their existing
HTTP/MCP error behavior. The instruction policy tells an automatic harness to
stop SkillWire calls without retry or substitution and continue normal work.
Operators should expect clients that never observed instructions to show no
spontaneous activation.

Required CI is deterministic and credential-free: `test:activation` validates
frozen fixtures, instruction publication, metadata, ranking/filtering, actual
registered MCP calls, failure bounds, attribution, and security boundaries. All
existing unit, contract, integration, E2E, evaluation, catalog/advisory, and
container jobs remain release gates. A real harness/model run is separate
non-blocking evidence and follows
[the manual protocol](autonomous-activation-evaluation.md); never add model or
harness credentials to required CI.

Production observability remains privacy-safe. Existing events may include tool
name, request/account/key identifiers, safe categorical code, and status. They
must not include task summaries, prompts, repository hashes, local paths,
skill/resource content, credentials, tokens, or headers. Because the protocol
has no task/session correlation field, production logs must not claim per-task
loop or spontaneous-activation metrics; those come from redacted evaluator
traces.

## Health and readiness

- `GET /health/live` reports process responsiveness only.
- `GET /health/ready` returns HTTP 200 only after startup cleanup succeeds;
  otherwise it returns 503 without protected details.
- An hourly cleanup failure makes readiness false. The next successful cleanup
  makes it ready again.
- Readiness probes PostgreSQL and the required import schema/advisory head, but
  never GitHub. A GitHub outage pauses new synchronization without affecting
  verified cached revision loads.

Compose waits for PostgreSQL health, then the migration job, then application
health. PostgreSQL is not published to the host.

## Shutdown and restart

SIGTERM and SIGINT stop new HTTP acceptance, close idle connections, drain
active requests up to `SKILLWIRE_SHUTDOWN_GRACE_MS`, stop the cleanup scheduler,
cancel and drain the GitHub scheduler when enabled, close the PostgreSQL pool,
and emit one bounded lifecycle result. Compose grants 15 seconds before force
termination.

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

For an autonomous attempt, do not automatically retry a 429, switch to
`user-requested`, or load another candidate. The current task should proceed
without SkillWire; a later materially different user objective may begin a new
attempt.

### Migration job fails

Confirm PostgreSQL connectivity and secret-file contents. A checksum drift
requires restoring the committed migration and creating a new migration for
corrections. Do not edit the migration table.

### Catalog verification fails

Keep traffic stopped. Run `catalog:verify` and `advisory:verify` from a clean
checkout. Never use publication as a repair path and never rewrite a published
revision.

### GitHub synchronization is delayed or quarantined

Inspect only bounded source/candidate state and stable reason codes through
`source:admin source:list`. Rate limits and outages are retryable and do not
alter the published head. Validation failures quarantine candidates atomically;
fix the upstream source or make an explicit administrator decision. Never bypass
fixed-origin, immutable-commit, license, path, resource, or dependency checks.

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
