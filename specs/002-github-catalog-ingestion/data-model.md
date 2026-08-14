# Data Model: GitHub Catalog Ingestion

## Modeling Rules

- Migrations are additive after existing versions `001` through `003`.
- PostgreSQL enums are avoided; bounded `text` columns use `CHECK` constraints so later migrations
  can add states without replacing enum types.
- Exact Git commit SHAs are `character(40)` with `^[0-9a-f]{40}$`; SHA-256 values are
  `character(64)` with `^[0-9a-f]{64}$`.
- Historical provenance, snapshots, content, revisions, observations, verification reports,
  classification events, curation decisions, and advisory events are create-only. Foreign keys use
  `ON DELETE RESTRICT`.
- Current coordinates, schedules, leases, and explicit current-state projections are mutable.
- Timestamps are `timestamptz`; identifiers are UUIDs except GitHub's positive numeric repository
  ID, monotonic sequences, and fencing tokens.
- Runtime roles receive only the minimum table privileges. Triggers reject `UPDATE` and `DELETE` on
  immutable tables even if a future grant is accidentally broadened.

## Source and Orchestration Entities

### `github_sources`

One canonical public GitHub repository, whether found by discovery or explicitly registered.

| Field | Type and constraints | Meaning |
| --- | --- | --- |
| `id` | UUID primary key | Internal opaque source ID |
| `github_repository_id` | positive `bigint`, unique | Stable GitHub identity across casing, rename, and transfer |
| `source_type` | `text CHECK = 'github-public'` | Fixed source boundary |
| `owner` / `repository` | bounded text | Current GitHub display coordinates |
| `normalized_owner` / `normalized_repository` | bounded lowercase text | Current dedup/search coordinates |
| `default_branch` | bounded validated text | Last observed mutable default branch |
| `visibility` | `text CHECK = 'public'` | Private sources cannot enter the model |
| `first_observed_at` / `last_observed_at` | timestamp | Discovery history |
| `current_published_snapshot_id` | nullable UUID FK | Atomic visible head, set only after successful publication |
| `metadata_etag` | nullable bounded text | Conditional mutable repository lookup |
| `metadata_cache_sha256` | nullable SHA-256 | Binds the ETag to its validated cached representation |

There is exactly one row per GitHub numeric repository ID. Coordinates never define canonical
identity after metadata resolution.

### `github_source_aliases`

Historical and current normalized owner/repository pairs.

- Primary key: `(normalized_owner, normalized_repository)`.
- Foreign key: `source_id -> github_sources`.
- Records `first_observed_at`, `last_observed_at`, and bounded alias reason.
- A coordinate cannot alias two sources. A conflicting GitHub response fails closed.

### `github_source_registrations`

Create-once authorization to synchronize an entire source.

- `source_id` is both primary key and foreign key.
- Records `registered_at`, bounded `registered_by`, `synchronization_enabled`, cadence,
  `next_sync_at`, and last terminal run reference.
- Repeated registration of the same resolved numeric repository is idempotent.
- No skill path, branch, tag, URL, or content is accepted by this entity.

### `github_discovery_runs`

One asynchronous configured search operation.

- State: `queued | running | succeeded | failed | cancelled`.
- Immutable budget/configuration snapshot: query-set hash, page/result/request/rate/byte ceilings,
  API version, and policy version.
- Bounded counters: queries, pages, results, unique sources, requests, retries, and response bytes.
- Optional conditional-request checkpoint hashes and opaque numeric page cursor.
- Terminal reason code and timestamps; never response bodies, tokens, raw URLs, or query text.
- Fencing token identifies the lease under which a terminal state may be written.

### `github_discovery_evidence`

Bounded evidence that one run found one source through a recognized layout.

- Unique on `(discovery_run_id, source_id, evidence_kind, normalized_path_hash)`.
- `evidence_kind`: `claude-plugin-manifest | nested-skill-document`.
- Stores a normalized path hash and safe file basename for administration, not file contents.
- Discovery evidence does not make the source or skill agent-visible.

### `github_sync_runs`

One registration or synchronization attempt for a source.

| Field group | Contents |
| --- | --- |
| Identity | UUID, source ID, trigger `registration | administrator | scheduled | discovery` |
| State | `queued | running | published | quarantined | failed | cancelled | superseded` |
| Pin | nullable exact commit SHA until resolved; exact tree SHA after commit lookup |
| Controls | immutable budget and validator-policy version snapshot |
| Counters | requests, retries, tree entries, candidate/resource/dependency counts, encoded/decoded bytes |
| Coordination | holder ID, fencing token, queued/start/heartbeat/terminal timestamps |
| Failure | stable terminal code, retryable boolean, no untrusted body or path |

A partial unique index on `source_id WHERE state IN ('queued', 'running')` enforces at most one
active synchronization request per repository. Repeated sync requests return that existing run or
the already-published snapshot.

### `github_job_leases`

Persistent lease/fencing row for `discovery` or `sync/<source UUID>`.

- `lease_key` primary key.
- `holder_id` random UUID for one process/job attempt.
- positive monotonic `fencing_token` incremented on every takeover.
- `acquired_at`, `renewed_at`, `lease_expires_at` based on database time.
- Acquisition, renewal, release, and final writes require exact key/holder/token predicates.
- Release expires the row rather than deleting it, retaining monotonic fencing.

## Immutable Snapshot and Catalog Entities

### `external_source_snapshots`

One fully evaluated immutable source commit.

- Unique `(source_id, commit_sha)`.
- Exact commit SHA and tree SHA; adapter kind `claude-plugin | nested-skill`.
- Optional manifest path/hash only for the plugin adapter.
- Tree response hash, license evidence hash, policy version, complete validation-input hash.
- Counts for tree entries, candidates, eligible revisions, quarantines, resources, dependencies, and
  decoded bytes.
- Finalization timestamp and external advisory-chain head when publication occurs.
- Created only in the final fenced finalization transaction. A completely evaluated all-quarantined
  commit may have a non-current snapshot and reports; a failed/incomplete acquisition has a sync run
  but no snapshot row.

### `external_skill_identities`

Stable skill identity scoped to the canonical repository and normalized skill root.

- Unique `(source_id, normalized_skill_root)`.
- Globally unique public `catalog_skill_id` matching the existing 80-character syntax. It is derived
  once from an external prefix, numeric repository ID, safe name slug, and a path-hash suffix; name
  changes do not change it.
- Display name is revision metadata rather than identity.
- A source path move creates a new identity unless future explicit rename evidence is separately
  specified; this feature does not guess renames.

### `external_import_candidates`

One candidate skill within one snapshot.

- Unique `(snapshot_id, normalized_skill_root)` and unique `(snapshot_id, normalized_name)` after
  case/Unicode normalization.
- Adapter, detected name, description, source-path hash, latest classification-event reference, and
  optional published/reused revision reference. The separate current-classification projection is
  authoritative for state.
- A quarantined candidate can exist without an external revision.
- A failed newer candidate does not mutate or hide the source's previously published head.

### `external_content_objects`

Global deduplication for normalized UTF-8 instructions, resources, license text, and notices.

- `sha256` primary key.
- `kind`: `instructions | resource | license | notice`.
- `media_type`: `text/markdown | text/plain`.
- `byte_length` and text body, with database byte-length checks.
- Insert uses `ON CONFLICT DO NOTHING`, followed by an exact body/kind/media/length comparison. Any
  mismatch for the same SHA-256 is `HASH_MISMATCH` and aborts publication.
- Deduplicating content never collapses repository, skill, revision, or provenance identities.

### `external_skill_revisions`

One immutable imported revision using canonical schema v2.

| Field | Meaning |
| --- | --- |
| `skill_identity_id` / `catalog_skill_id` / `revision` | Stable exact SkillWire lookup identity; unique `(catalog_skill_id, revision)` |
| `schema_version` | Exactly `2` |
| `bundle_sha256` | SHA-256 of complete canonical v2 serialization; unique with canonical byte verification |
| `content_identity_sha256` | Canonical skill identity excluding observation commit; unique per skill identity |
| `origin_snapshot_id` / `origin_commit_sha` | First exact source snapshot that published this revision |
| `normalized_skill_root` / `skill_document_path` | Exact safe source location at publication |
| `name` / `description` / capabilities | Bounded search metadata |
| `instructions_sha256` | FK to the instruction content object |
| `invocation_mode` | `automatic | user-only` |
| `spdx_license_id` | Allowlisted SPDX-compatible identifier |
| `license_sha256` / `notice_sha256` | Exact pinned evidence content hashes |
| `attribution` | Bounded source attribution preserved with revision |
| `trust_at_publication` | Immutable `structurally-verified`; Feature 001 remains `trusted` |
| `canonical_bytes` | Exact canonical JSON bytes or text with byte/hash equality constraint |
| `published_at` | Publication timestamp, never used in canonical hashing |

The revision string is deterministic `gh-<64 lowercase bundle hash>`, within the existing revision
limit and never a mutable ref. The content identity includes source repository identity and skill
root, instructions, metadata, invocation mode, license/attribution, dependencies, and resources, but
not the observation commit. The complete bundle includes the first publication commit and all those
facts.

### `external_revision_resources`

One declared textual resource manifest entry.

- Primary key `(revision_id, normalized_resource_path)`.
- Content-object SHA-256, media type, byte length, and canonical ordinal.
- Paths are safe relative paths exposed from the skill root, not repository-absolute paths.
- Maximum 64 rows per revision, enforced by publication validation and database trigger.
- Zero resources are valid for canonical schema v2; Feature 001 v1 behavior is unchanged.

### `external_revision_dependencies`

One directed same-source dependency resolved at the origin snapshot.

- Primary key `(source_revision_id, target_skill_identity_id)`.
- Target exact revision ID, `required` boolean, recognized evidence kind, evidence source content
  hash, and bounded byte/line locator.
- No evidence excerpt is stored.
- A deferred validation trigger or publication procedure verifies source and target repository IDs
  match and both target observations belong to the same snapshot.
- Self edges and cycles are rejected before insertion; maximum 32 edges per revision.

### `external_snapshot_skill_observations`

Evidence for each candidate at a later exact commit.

- Primary key `(snapshot_id, skill_identity_id)`.
- Candidate ID, observed content-identity hash, nullable revision ID, and outcome
  `published | reused | quarantined | missing`.
- `reused` must reference a revision with exactly the same content-identity hash.
- `missing` is recorded only after a complete non-truncated snapshot and supports an unavailable
  advisory; it never deletes prior data.

## Verification and Policy Entities

### `external_verification_reports`

- One deterministic report per candidate and policy/validator version.
- Stores canonical input SHA-256, report SHA-256, result `passed | failed`, and timestamp.
- A unique key prevents duplicate reports for identical input and versions.
- Report completeness is a prerequisite for publication.
- At the database boundary, every candidate or revision event whose next classification is
  `verified` must reference a `passed` report for the event's candidate or initiating candidate.
  Migration baselines are explicitly synchronization events, not verification transitions.

### `external_validation_findings`

- Append-only findings ordered deterministically by reason, subject, and safe locator.
- Fields: report ID, stable reason code, severity `error | warning | info`, subject kind, bounded
  locator hash, and bounded allowlisted JSON context containing counts/expected kinds only.
- No instructions, resources, license text, owner/repository, raw path, URL, token, or response body.

Stable error reason codes are:

`MANIFEST_INVALID`, `MANIFEST_DUPLICATE_SKILL`, `SKILL_SCHEMA_INVALID`,
`SKILL_DUPLICATE_IDENTITY`, `COMMIT_MISMATCH`, `TREE_TRUNCATED`, `TREE_OVERSIZED`,
`TREE_AMBIGUOUS`, `OBJECT_UNSUPPORTED`, `PATH_UNSAFE`, `RESOURCE_MISSING`,
`RESOURCE_NON_TEXT`, `RESOURCE_OVERSIZED`, `LICENSE_MISSING`, `LICENSE_UNSUPPORTED`,
`LICENSE_CONFLICT`, `ATTRIBUTION_MISSING`, `DEPENDENCY_MISSING`, `DEPENDENCY_AMBIGUOUS`,
`DEPENDENCY_CYCLE`, `HASH_MISMATCH`, and `PUBLICATION_CONFLICT`.

Network/rate/timeout failures are retryable run outcomes, not quarantine findings, unless the
response itself deterministically proves a policy violation.

### `external_classification_events`

Append-only raw per-observation candidate transition history.

- Subject is exactly one candidate ID with prior and next classifications.
- Classification: `discovered | verified | quarantined | curated`.
- Actor kind: `discovery | verifier | administrator | synchronization`.
- Bounded actor ID, reason code, report reference, and timestamp.
- The current candidate projection may reference only an event for the same candidate and matching
  next classification.

### `external_revision_classification_events`

Append-only shared revision eligibility transition history.

- Subject is exactly one published revision ID; an initiating candidate ID records attribution but
  is not a second event subject.
- Effective classification: `verified | quarantined | curated`.
- The initiating candidate must be an observation of the subject revision, and a verifier report
  must belong to that candidate.
- The current revision projection may reference only an event for the same revision and matching
  next classification.
- Candidate and revision transitions are validated and appended independently. An operation that
  changes both projections writes two truthful events; revision-only transitions do not change raw
  sibling candidate history.

### `external_current_classifications`

Mutable raw per-observation projection keyed by candidate.

- Points to the latest classification event and stores current state.
- Search joins only the current published snapshot and `verified | curated` subjects.
- Current classification is never included in canonical revision bytes.

### `external_current_revision_classifications`

Mutable effective eligibility projection keyed by published revision.

- Points only to the latest event for the same revision and stores the matching effective state.
- This projection is authoritative for administrative effective-state display/filtering and MCP
  eligibility.

### `external_curation_decisions`

- One row per candidate or revision classification event that promotes `verified -> curated`; the
  decision references exactly one event subject.
- Records authenticated administrator identity, bounded reason code/rationale hash, and timestamp.
- Automation has no write path to this table.
- Changed content starts a new verified revision and does not inherit curation. An unchanged snapshot
  reusing the exact revision may retain that revision's explicit decision.

### `external_revision_advisory_events` and `external_advisory_chain_head`

Separate append-only chain for imported revisions; the Feature 001 version-controlled chain remains
unchanged.

- Singleton head stores last monotonic sequence and event hash.
- Events store sequence, previous hash, event hash, exact revision, kind
  `availability | security`, state `available | unavailable | revoked`, stable reason, and effective
  time.
- Appending locks the head `FOR UPDATE`, validates and hashes canonical event data, inserts the event,
  then advances the head in one transaction.
- Search excludes unavailable and revoked imports. Exact PostgreSQL-backed load may return an
  unavailable revision because the verified immutable bundle is local; revoked remains
  non-disclosing `NOT_FOUND`.
- Only a complete new snapshot can prove deletion of a skill from an otherwise public repository. A
  source-wide loss of public availability requires the separate repeated-confirmation policy defined
  in `operational-synchronization.md`; one 404, timeout, rate exhaustion, budget exhaustion, or
  truncated tree cannot create an unavailable event.

## Relationships and Visibility

```text
github_sources 1 ── 0..1 github_source_registrations
       │
       ├── * github_sync_runs
       ├── * external_source_snapshots
       └── * external_skill_identities
                      │
snapshot 1 ── * candidates ── 0..1 external_skill_revisions
   │                  │                     │
   └── * observations ┘                     ├── * resources ── 1 content object
                                            ├── * dependency edges ── 1 target revision
                                            ├── * revision classification events
                                            └── * advisory events
```

Candidates retain their own raw classification events and current projections outside the revision
subtree shown above.

The only imported rows visible to agents are revisions reached through
`github_sources.current_published_snapshot_id`, an eligible current classification, and an available
advisory status. Exact load bypasses the current-head requirement only for an already published
immutable revision, while still enforcing classification and advisory rules.

## Required Indexes

- Source numeric ID and normalized aliases.
- Registered sources by `synchronization_enabled, next_sync_at`.
- Runs by state/not-before/creation time and partial active-source uniqueness.
- Leases by expiry.
- Snapshots by source/commit and source/publication time.
- Skill identities by source/root and public catalog skill ID.
- Candidates by snapshot/classification and normalized name.
- Revisions by skill/content identity, bundle hash, and origin snapshot.
- Content objects by SHA-256 primary key.
- Observations by snapshot/outcome and revision.
- Findings by report/severity/code.
- Classification and advisory events by subject/revision and descending sequence.

## Transactional Invariants

1. No snapshot or imported revision exists without complete deterministic verification.
2. The source head points only to a fully committed snapshot.
3. A candidate is never agent-visible unless its revision, resources, dependencies, report,
   classification, and advisory projection are committed together.
4. The same source/commit, skill/content identity, revision bundle, dependency, or content object is
   idempotent; a same-key/different-body collision aborts.
5. A late or cancelled lease holder cannot publish, classify, append advisories, or mark a run
   successful.
6. Previously published immutable rows are never updated or deleted, including after upstream
   deletion, quarantine, or source removal.
