# Ingestion State Machine

## Independent State Dimensions

Feature 002 deliberately does not overload one status with four different concerns:

| Dimension | Purpose | Values |
| --- | --- | --- |
| Run state | Operational progress of discovery/synchronization | `queued`, `running`, terminal result |
| Candidate classification | Current policy eligibility | `discovered`, `verified`, `quarantined`, `curated` |
| Publication identity | Immutable snapshot/revision existence | absent, published, reused |
| Advisory status | Current load/search availability | `available`, `unavailable`, `revoked` |

`trustAtPublication` is a fifth immutable fact. For imported revisions it is
`structurally-verified`; it never changes when current classification or advisory status changes.

## Discovery Run

```text
queued ──lease acquired──> running ──complete──> succeeded
   │                         │  ├──cancel───────> cancelled
   │                         │  └──error────────> failed
   └──cancel───────────────────────────────────> cancelled
```

- Only one global discovery lease holder executes a run.
- Search results are hints. Each resolvable public numeric GitHub repository ID is upserted once and
  receives discovery evidence.
- A newly observed repository/candidate starts `discovered`; discovery never publishes it.
- Search incompleteness, pagination/rate budget exhaustion, or a transient GitHub failure terminates
  the run with a stable operational code. Already committed evidence from prior completed page
  transactions may remain, but no catalog visibility changes.
- Cancellation and lease expiry prevent a terminal success update from the old holder.

## Registration

```text
unregistered source ──source:add──> registered + queued sync
registered source   ──source:add──> same registration + existing/new queued sync
```

- The administrator supplies only `owner` and `repository` components. The service resolves public
  GitHub metadata and numeric repository identity before create-once registration.
- Aliases, casing, rename, and transfer resolving to the same numeric ID return the existing source.
- Registration authorizes all skills covered by a recognized adapter. No individual skill can be
  registered.
- The CLI returns after the durable run is queued; it does not make an agent request wait for GitHub.

## Synchronization Run

```text
queued ──per-source lease──> running
 running ──same published commit──────────────> published (idempotent)
 running ──complete + eligible candidates────> published
 running ──complete + policy failures────────> quarantined
 running ──transient/rate/budget failure──────> failed (retryable as classified)
 running ──cancel/shutdown────────────────────> cancelled
 running ──newer fencing token────────────────> superseded
```

Processing stages while `running`:

1. Revalidate the source as public and capture current numeric ID/canonical coordinates.
2. Resolve the default branch ref once to a complete commit SHA.
3. Read the exact commit and recursive tree; reject truncation, ambiguity, unsupported objects, or
   budget overrun.
4. Select one adapter: `.claude-plugin/plugin.json` is authoritative when present; otherwise use
   bounded nested `SKILL.md` discovery.
5. Fetch only selected regular non-executable blobs by exact blob SHA.
6. Parse instructions/resources, license/attribution, invocation mode, and dependency evidence.
7. Build deterministic candidate reports and canonical content identities.
8. Publish in one short fenced transaction.

Network, parsing, and hashing do not hold a database transaction. The final transaction locks the
lease and source, rechecks holder/token/expiry/cancellation, and either commits the complete snapshot
or rolls back every publication effect.

### Atomic Publication Outcome

- Passing candidates receive `verified` classification and are inserted or map to an existing exact
  revision.
- Deterministically failing candidates receive `quarantined` with stable findings and no revision.
- All passing candidates and all reports/findings for that complete snapshot become visible in one
  transaction. No half-published snapshot is possible.
- A deterministic repository-wide failure, such as truncated tree or conflicting license evidence,
  quarantines the affected snapshot/candidates and leaves the prior published source head visible.
- A network/rate/timeout/cancellation failure creates no snapshot and leaves classifications and
  source head unchanged.

## Candidate Classification

| From | Event | To | Preconditions |
| --- | --- | --- | --- |
| absent | discovery or snapshot candidate creation | `discovered` | Recognized evidence only; never visible |
| `discovered` | deterministic automatic validation passes | `verified` | Complete report and atomic published/reused revision |
| `discovered` | required validation fails | `quarantined` | At least one stable error finding |
| `verified` | authenticated administrator curate | `curated` | Exact candidate/revision already structurally verified |
| `verified` or `curated` | authenticated administrator quarantine | `quarantined` | Bounded administrator reason; immutable revision untouched |
| `quarantined` | explicit automatic reverify passes | `verified` | New complete report; no automatic curation |
| `quarantined` | explicit administrator review after passing reverify | `curated` | Two events: reverify to verified, then admin curate |

Disallowed transitions fail without side effects. Automation never assigns `curated`. New changed
content creates a new verified revision and does not inherit curation. A later snapshot that reuses
the exact revision may retain the curation decision for that exact immutable content.

## Revision Reuse and Change

For each skill identity at a complete new snapshot:

1. Compute canonical content identity excluding the observation commit.
2. If it equals an existing revision for that identity, insert a `reused` observation referencing
   the existing revision. Do not alter its origin commit, canonical bytes, hashes, or
   `trustAtPublication`.
3. If it differs, create a new canonical v2 revision whose bundle includes this exact origin commit.
4. If validation fails, record a quarantined candidate/observation and retain the previous published
   head.
5. Reprocessing the same source/commit returns the existing snapshot and produces no duplicates.

## Upstream Removal and Advisory State

Only a complete, non-truncated, within-budget snapshot can prove that a previously published skill
is missing from an otherwise public repository.

```text
available ──confirmed upstream deletion/private removal──> unavailable
available or unavailable ──security advisory────────────> revoked
unavailable ──same exact content restored/reviewed───────> available
revoked ──explicit verified advisory event───────────────> available or unavailable
```

- Deletion appends an external availability advisory and removes the skill from default search.
- PostgreSQL retains the verified immutable bundle, so an exact `load_skill` for an unavailable
  revision can remain reproducible without contacting GitHub.
- Revoked exact load/resource returns the existing non-disclosing not-found response.
- One 404, upstream outage, rate limit, incomplete search, truncated tree, budget exhaustion, or
  timeout does not prove deletion and cannot append an unavailable advisory.
- Source-wide public loss is a distinct confirmation path: three authenticated uncached repository
  metadata 404/non-public results spanning at least 24 hours, followed by one fresh immediate
  confirmation and no newly discovered alias for the numeric repository ID, append
  `UPSTREAM_PUBLIC_SOURCE_UNAVAILABLE` for current revisions. The event asserts public
  unavailability, not whether GitHub deleted or privatized the repository.

## Scheduler and Recovery

- Due discovery/sync rows are claimed in a short `FOR UPDATE SKIP LOCKED` transaction, then protected
  by the corresponding persistent lease.
- Heartbeats renew using exact holder/token. Losing renewal aborts the job signal.
- After expiry, a new process acquires a higher fencing token and marks the prior run superseded or
  interrupted before retrying.
- Crash after publication but before lease release is safe: the next worker finds the existing
  source/commit snapshot and completes idempotently.
- Graceful shutdown marks readiness false, stops new claims, aborts GitHub/body/backoff work, awaits
  a bounded drain, prevents commits after cancellation, expires held leases best-effort, and closes
  PostgreSQL.
