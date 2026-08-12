# Operational Synchronization

## Runtime Topology

Discovery and synchronization run inside each SkillWire service process as lifecycle tasks. Multiple
containers coordinate only through PostgreSQL jobs, leases, source heads, and fencing tokens. There
is no Redis, external queue, worker deployment, or microservice.

Agent requests query the already published first-party and PostgreSQL imported catalogs. They never
join, wait for, enqueue, or trigger ingestion work.

## Configuration

The implementation adds strict configuration under the existing fail-closed configuration reader.
Suggested names and defaults are contract inputs, not environment values accepted from MCP clients.

| Setting | Default | Hard maximum / behavior |
| --- | ---: | --- |
| `SKILLWIRE_GITHUB_INGESTION_ENABLED` | `false` | When `true`, missing token/query/budget config fails startup |
| `SKILLWIRE_GITHUB_TOKEN` | none | Required for live discovery/sync; secret, never logged |
| `SKILLWIRE_GITHUB_API_VERSION` | `2026-03-10` | Must equal the compiled supported version |
| `SKILLWIRE_GITHUB_DISCOVERY_QUERIES` | recognized manifest and `SKILL.md` queries | Operator-controlled bounded query set; not logged |
| `SKILLWIRE_GITHUB_MAX_QUERIES` | `8` | `16` |
| `SKILLWIRE_GITHUB_MAX_PAGES_PER_QUERY` | `5` | `10` |
| `SKILLWIRE_GITHUB_RESULTS_PER_PAGE` | `100` | `100` |
| `SKILLWIRE_GITHUB_MAX_RESULTS_PER_RUN` | `1000` | `4000` |
| `SKILLWIRE_GITHUB_MAX_REQUESTS_PER_RUN` | `1000` | `2000` |
| `SKILLWIRE_GITHUB_MAX_TREE_ENTRIES` | `20000` | `50000`; any GitHub `truncated` tree still fails |
| `SKILLWIRE_GITHUB_MAX_CANDIDATES` | `256` | `512` |
| `SKILLWIRE_GITHUB_MAX_RESOURCES_PER_SKILL` | `64` | `64` |
| `SKILLWIRE_GITHUB_MAX_DEPENDENCIES_PER_SKILL` | `32` | `64` |
| `SKILLWIRE_GITHUB_MAX_TEXT_BYTES` | `262144` | Existing 256 KiB per object |
| `SKILLWIRE_GITHUB_MAX_BUNDLE_BYTES` | `2097152` | Existing 2 MiB per revision |
| `SKILLWIRE_GITHUB_MAX_REPOSITORY_BYTES` | `33554432` | `67108864` |
| `SKILLWIRE_GITHUB_REQUEST_TIMEOUT_MS` | `30000` | Must be below operation deadline |
| `SKILLWIRE_GITHUB_OPERATION_TIMEOUT_MS` | `300000` | Five-minute acceptance ceiling |
| `SKILLWIRE_GITHUB_MAX_ATTEMPTS` | `3` | `4` |
| `SKILLWIRE_GITHUB_GLOBAL_JOBS` | `2` | `4`; one request at a time per job |
| `SKILLWIRE_GITHUB_LEASE_MS` | `60000` | Heartbeat before one-third expiry |
| `SKILLWIRE_GITHUB_SYNC_INTERVAL_MS` | `3600000` | Positive bounded cadence |

`GITHUB_TOKEN` is also accepted as an explicit alias only for the manual live smoke command; the
production service uses the SkillWire-prefixed secret. Fixture-mode tests inject fetch and do not
require a real token. The API origin cannot be configured.

## Job Claim and Lease Protocol

1. A short database transaction selects a due queued/delayed job with `FOR UPDATE SKIP LOCKED` and
   marks its attempt starting.
2. Acquire `discovery` or `sync/<source UUID>` with an atomic lease upsert. A takeover increments the
   fencing token.
3. Commit the claim transaction before any GitHub request.
4. Run one job with an absolute deadline and an abort signal. Renew the lease using exact
   key/holder/token; failed renewal aborts immediately.
5. Before publication/terminal side effects, lock the lease row `FOR UPDATE`, require exact live
   holder/token/expiry, and check cancellation.
6. Commit publication, source head, run terminal state, and next schedule together where applicable.
7. Expire the lease best-effort using exact holder/token. Never delete the lease row.

Only one active sync row and lease may exist per source. Discovery has one global lease. Scheduler
polls use jitter and bounded query size to avoid synchronized container wakeups.

## GitHub Request Operation

Every call sends fixed `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2026-03-10`, `User-Agent: SkillWire/<version>`, and operator Bearer
authorization. The adapter captures ETag, pagination, retry, and numeric rate-limit fields into the
run's bounded state without logging raw headers. Redirect mode is manual; only one validated
same-origin repository-metadata rename hop is reconstructed internally, and every other 3xx fails.

- Mutable discovery/repository metadata may use `If-None-Match` only with its validated cached body.
- Immutable commit/tree/blob responses are cached only by exact request identity plus verified
  object/body hashes.
- A 304 without the bound cached body fails closed.
- A rejected redirect, schema error, SHA mismatch, or deterministic 4xx is not retried.
- Retryable network/5xx/429 waits obey the shared deadline and rate budget. No retry sleeps past the
  operation deadline.
- When primary rate remaining reaches the configured reserve, the run pauses until reset if the
  deadline permits; otherwise it terminates retryably and schedules after reset.
- Secondary-limit guidance is respected with bounded delay and reduced global concurrency; the
  service never creates a Redis-based distributed throttle.

## Scheduling Policy

- Registration queues an immediate sync for the repository's current default branch.
- Administrator `sync` queues an immediate idempotent sync unless one is active.
- Scheduled sync examines only registered, enabled, due sources and is distributed across instances
  through PostgreSQL.
- Discovery is separately scheduled/configured and never automatically registers or publishes a
  source solely because search found it.
- Successful sync schedules the next cadence from database time.
- Retryable failure uses bounded exponential backoff plus jitter and respects GitHub reset time.
- Deterministic quarantine completes the run and uses the normal cadence or explicit administrator
  verify; it does not hot-loop.
- Reprocessing the same resolved commit is a successful idempotent no-op.

### Confirming upstream unavailability

- Skill-level deletion requires a complete, non-truncated, within-budget snapshot of a still-public
  source that omits the previously published skill.
- One repository metadata 404/non-public response is retryable and cannot change advisories.
- Source-wide public loss requires three authenticated uncached terminal metadata results spanning
  at least 24 hours, followed by one fresh immediate confirmation, with no successful response or
  newly discovered coordinate alias for the same numeric repository ID between them.
- The resulting reason is `UPSTREAM_PUBLIC_SOURCE_UNAVAILABLE`, not a claim of deletion. All current
  source revisions become unavailable but remain exact-loadable from verified PostgreSQL bundles
  unless revoked.
- Any later public resolution to the same numeric repository ID requires a complete verified sync
  before an availability-restored event.

## Readiness and Health

- Liveness remains process-level and does not call GitHub.
- Readiness requires successful migrations, existing startup audit cleanup, active PostgreSQL probe,
  access to required Feature 001 and external tables/functions, verification of the current imported
  provider/advisory head, and scheduler initialization.
- If ingestion is enabled, readiness also requires valid static GitHub configuration, not live GitHub
  reachability. A GitHub outage must not make immutable search/load unavailable.
- PostgreSQL outage changes readiness to false through the existing active probe. Recovery restores
  readiness only after schema/provider probes succeed.
- Corrupt imported canonical bytes, advisory chain, or source-head integrity makes readiness fail
  closed until repaired; a single quarantined source does not.

## Shutdown and Crash Recovery

Graceful shutdown sequence:

1. Mark readiness false and stop accepting new scheduler claims.
2. Abort every active GitHub request, response stream, retry wait, and parser/publisher operation.
3. Await a bounded job drain; final transactions see cancellation and roll back.
4. Expire held leases best-effort using exact holder/token.
5. Stop existing audit scheduler and close PostgreSQL after agent requests drain.

After a crash, lease expiry permits a higher fencing token. Recovery marks stale runs superseded and
requeues as policy permits. If the old process committed publication but did not release, the unique
source/commit snapshot makes retry idempotent. If it crashed before commit, the previous source head
is unchanged.

## Monitoring Without Sensitive Data

Metrics (not high-cardinality logs): run counts/durations by result, GitHub request counts/status
class, retry/rate-limit categories, tree/candidate/resource count buckets, decoded-byte buckets,
publication/reuse/quarantine totals, queue age, lease takeover/renewal failure, due-source lag, and
readiness probe state.

Structured security logs include opaque run/source IDs, event type, stable reason code, state,
bounded counters, and duration bucket only. Coordinates, commits, paths, queries, content, tokens,
URLs, response headers, and client repository hashes are prohibited.

## Operator Recovery Procedures

- **GitHub unavailable/rate limited**: leave service ready, inspect bounded run codes/metrics, wait for
  scheduled retry/reset, and do not delete/recreate sources.
- **Quarantined source**: use `source:admin list` for safe reason codes, repair policy/config only when
  appropriate, then request `verify`; never mutate a published revision.
- **Stuck running job**: confirm lease expiry and database clock; a new scheduler safely takes over.
  Do not manually alter fencing tokens.
- **PostgreSQL outage**: readiness stays false; restore database, validate migrations/advisory head,
  then allow automatic readiness recovery.
- **Corrupt imported bundle/head**: keep readiness false and imports unavailable, restore PostgreSQL
  from the documented backup boundary, run integrity verification, and never rebuild an old revision
  from a mutable upstream branch.
- **Source removed/private**: require the repeated public-unavailability confirmation policy before
  appending unavailable. Retain all published bundles and audit history.

## Manual Live Smoke

The optional manual workflow supplies a least-privilege `GITHUB_TOKEN`, uses a disposable PostgreSQL
database, targets only the fixed acceptance repository and exact pinned commit, enforces production
budgets, and performs no write to GitHub. It is informational/nonblocking and cannot replace required
recorded-fixture CI.
