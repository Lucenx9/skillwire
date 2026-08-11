# Data Model: Remote Skill Delivery MVP

## Model Boundaries

- Catalog source inputs and published batches are version-controlled files.
- One authoritative PostgreSQL database stores accounts, API keys, repository memory, and erasure
  audit records.
- Repository memory is never cached; every operation queries PostgreSQL directly.
- The only application cache stores complete verified immutable catalog bundles.
- GitHub release responses and previous-chain bytes are transient verification inputs and are never
  runtime data or persisted application state.
- No source code, raw prompt, local path, repository metadata, secret, or caller URL is stored.

## Catalog Domain Types

### `CatalogSkill`

| Field | Type | Rules |
|-------|------|-------|
| `id` | string | Stable lowercase kebab-case identifier. |
| `name` | string | Bounded display name. |
| `description` | string | Compact preview-safe text, never instructions. |
| `capabilities` | string[] | Bounded normalized ranking terms. |
| `revisions` | string[] | Exact immutable revision identifiers; no floating aliases. |

### `SourceReference`

| Field | Type | Rules |
|-------|------|-------|
| `repository` | string | Server-controlled logical source; never caller supplied. |
| `path` | string | Normalized safe relative catalog path. |
| `sourceRevision` | string | Immutable source revision. |

### `PublishedProvenance`

| Field | Type | Rules |
|-------|------|-------|
| `source` | `SourceReference` | Immutable and bundle-hash covered. |
| `owner` | string | `SkillWire maintainers` for launch. |
| `license` | string | `Apache-2.0` for launch. |
| `trustAtPublication` | object | Immutable status and reviewed rationale. |

`trustAtPublication` never changes after publication. Current security or availability state is
derived separately from the advisory chain.

### `ResourceManifestEntry`

| Field | Type | Rules |
|-------|------|-------|
| `path` | string | Unique normalized safe relative path. |
| `mediaType` | string | `text/plain` or `text/markdown`. |
| `byteLength` | integer | Normalized UTF-8 byte length within policy. |
| `sha256` | string | 64 lowercase hexadecimal characters. |

Entries are ordered lexicographically by normalized path in the canonical bundle.

### `SkillRevision`

| Field | Type | Rules |
|-------|------|-------|
| `skillId` | string | References one inventory entry. |
| `revision` | string | Exact immutable revision identifier. |
| `publishedProvenance` | `PublishedProvenance` | Complete immutable provenance. |
| `instructions` | string | Validated normalized Markdown. |
| `resources` | map | Declared normalized text keyed by manifest path. |
| `resourceManifest` | `ResourceManifestEntry[]` | Complete, sorted, unique. |
| `bundleSha256` | string | SHA-256 of the canonical complete revision bundle. |

Canonical serialization includes schema version, skill identity, exact revision, all published
provenance, normalized instructions, manifest metadata, resource hashes, and normalized resource
content. The `bundleSha256` field itself is excluded from its preimage.

### `RevisionAdvisory`

| Field | Type | Rules |
|-------|------|-------|
| `sequence` | positive integer | Starts at 1 and increments by exactly one. |
| `skillId` | string | Exact catalog skill. |
| `revision` | string | Exact published revision. |
| `kind` | enum | `security-revoked`, `availability-unavailable`, or `availability-restored`. |
| `reason` | string | Bounded maintainer explanation. |
| `effectiveAt` | timestamp | UTC publication time. |
| `previousEventHash` | string | Prior event hash; 64 zeroes for event 1. |
| `eventHash` | string | SHA-256 of canonical event fields excluding this field. |

The verified chain folds to `currentAdvisoryStatus`: `available`, `unavailable`, or terminal
`revoked`.

### `SearchPreview`

Contains skill ID, name, description, capability summary, exact revision,
`trustAtPublication`, derived `currentAdvisoryStatus`, and deterministic score components. It cannot
contain instructions, resource bodies, or raw advisory events.

## Catalog Publication Records

### `CatalogInventoryEntry`

Contains the exact required identifier, purpose, expected resource path, owner, license, logical
repository source reference, immutable source revision, and reviewed trust rationale. The ten-entry
inventory exists before any bundle construction.

### `RevisionPublicationRecord`

One generated JSON record per launch skill inside a published batch:

| Field | Type | Rules |
|-------|------|-------|
| `schemaVersion` | integer | Canonical record format version. |
| `skillId` | string | Exact inventory ID. |
| `revision` | string | Exact immutable revision. |
| `bundleSha256` | string | Recomputed from the complete bundle. |
| `publishedProvenance` | object | Exact immutable provenance. |
| `instructionsSha256` | string | Hash of normalized instructions. |
| `resourceManifest` | array | Complete sorted entries with hashes. |
| `sourcePaths` | object | Repository-controlled instruction, provenance, and resource paths. |

The record is traceable independently but becomes published only as part of its atomic release
directory.

### `CatalogRelease`

Stored as `catalog/releases/<releaseId>/release.json`:

| Field | Type | Rules |
|-------|------|-------|
| `schemaVersion` | integer | Release format version. |
| `releaseId` | string | Stable lowercase release identifier. |
| `genesis` | boolean | True only for the first published release. |
| `previousReleaseCommit` | string or null | Null for genesis; otherwise exact 40-character lowercase commit SHA. |
| `inventorySha256` | string | Hash of canonical inventory. |
| `advisoryChainHead` | string | Verified final event hash or 64 zeroes. |
| `revisionCount` | integer | Exactly 10 for the launch batch. |
| `revisions` | array | Ten records sorted by skill ID with revision, bundle hash, and record path. |
| `publishedAt` | timestamp | Maintainer-supplied deterministic release timestamp. |

For genesis, no earlier batch or non-draft GitHub release may exist, and the candidate advisory chain
must be initial. Every later release must match `previousReleaseCommit` to the tag-resolved exact
commit of the unique latest `draft: false` GitHub release by `published_at`, including a published
prerelease.

### `CatalogPublishResult`

Structured stdout from `publish`: validated release ID (or null when that input is invalid), overall
`created` result, final batch path when created, bounded errors, and exactly ten per-revision results.
Revision, bundle hash, and record path are nullable only when rejection prevents safe derivation;
every result is `created` or carries a bounded rejection code. On rejection, no final release
directory exists.

### `CatalogVerifyResult`

Structured stdout from `verify`: release ID, overall validity, inventory/advisory/release checks,
publication-claim absence, GitHub baseline check, and one result per revision. It contains no content
bodies or secrets. Non-genesis output also records the selected GitHub release ID, its
`published_at`, and the resolved commit; those fields are null for genesis.

## Evaluation Types

### `SearchEvaluationCase`

Stable case ID, bounded task query, expected launch-skill ID, and rationale. The corpus has at least
30 cases and at least three per skill.

### `JourneyEvaluationCase`

Stable case ID, task description, expected skill ID, optional exact resource path, selected result,
and operation counts. The matrix has at least 20 cases.

Both fixtures are committed before ranking and journey implementations.

## Authentication and Repository Memory

### `RequestPrincipal`

Authenticated account ID, API-key ID, and request ID. Account identity is derived only from bearer
authentication.

### `RepositoryHash`

Opaque client-generated value matching `^[0-9a-f]{64}$`. SkillWire never derives or enriches it.

### `RepositoryMemoryScope`

Composite `(accountId, repositoryHash)` tenant boundary used as a predicate in every query and
mutation.

### `SkillUsageRecord`

| Field | Type | Rules |
|-------|------|-------|
| `accountId` | UUID | Authenticated tenant. |
| `repositoryHash` | char(64) | Opaque lowercase hash. |
| `skillId` | string | Exact published skill. |
| `revision` | string | Exact immutable revision. |
| `bundleSha256` | char(64) | Published revision integrity binding. |
| `firstUsedAt` | timestamp | Database time on first acknowledged load. |
| `lastUsedAt` | timestamp | Database time on latest acknowledged load. |
| `useCount` | positive integer | Incremented on repeated loads. |
| `outcome` | enum or null | `useful`, `neutral`, `unsuccessful`, or null. |

The composite `(account_id, repository_hash, skill_id, revision)` is unique. There is no outcome
history and no repository-memory cache representation.

### `ErasureAuditRecord`

Exactly six permitted fields:

| Field | Type | Rules |
|-------|------|-------|
| `accountId` | UUID | Authenticated account only. |
| `requestId` | UUID | Unique request correlation. |
| `createdAt` | timestamp | Authoritative database time. |
| `expiresAt` | timestamp | Exactly `createdAt + 30 days`. |
| `operationResult` | enum | Bounded success result. |
| `removedRecordCount` | nonnegative integer | Aggregate count only; never returned to caller. |

No repository hash, skill identity, outcome, query, or usage detail is allowed.

## PostgreSQL Tables

### `accounts`

- `id uuid primary key`
- `status text check (status in ('active','disabled'))`
- `created_at timestamptz not null`

### `api_keys`

- `id uuid primary key`
- `account_id uuid not null references accounts(id)`
- `public_id text unique not null`
- `secret_digest bytea not null`
- `created_at`, `expires_at`, `revoked_at`, `last_used_at` timestamps
- no plaintext or recoverable secret

### `repository_skill_usage`

- fields from `SkillUsageRecord`
- primary key `(account_id, repository_hash, skill_id, revision)`
- check constraints for hash, outcome, count, and timestamps
- tenant-first index for bounded listing/ranking queries
- row access occurs only through account-and-repository predicates

### `repository_erasure_audit`

- exactly the six fields from `ErasureAuditRecord`
- `request_id` primary key
- constraint `expires_at = created_at + interval '30 days'`
- expiry index on `expires_at`
- application reads require `expires_at > statement_timestamp()`

### `schema_migrations`

Version, checksum, and applied timestamp. The migration runner rejects checksum drift and serializes
concurrent migration attempts.

## State Transitions

### Atomic release publication

```text
unpublished inputs
  -> fully validated in-memory batch
  -> exclusive publication claim acquired
  -> complete sibling staging directory
  -> atomic rename
  -> published immutable release directory
```

Any validation, claim, or staging failure returns to `unpublished inputs` with no visible batch. An
existing claim, final path, or revision identity transitions directly to rejection, never overwrite.
The claim is held from the duplicate scan through rename; a stale claim blocks automatic progress.

### Verification

```text
published files -> read-only recomputation -> valid | invalid
```

Verification has no transition that modifies state.

### Advisory release baseline

```text
genesis + no non-draft GitHub release + initial local chain -> valid genesis
non-genesis + unique latest non-draft published release -> tag -> exact commit -> prior bytes
  -> valid append | invalid
```

Any absent/unavailable step is `invalid`; no fallback state exists.

### Repository usage

```text
absent -> load upsert -> present
present -> repeated load -> count/timestamp updated
present -> valid outcome -> current outcome replaced
present -> forget transaction -> absent
```

Every transition is committed in PostgreSQL before acknowledgment.

### Erasure audit

```text
active -> logically expired at expiresAt -> physically deleted by cleanup
```

Logical expiry is unconditional. Physical deletion occurs within one hour only while service and
database availability are continuous; after downtime, startup cleanup must complete before
readiness.

## Transaction and Consistency Boundaries

- Load usage upsert and outcome replacement use tenant-scoped PostgreSQL transactions/statements.
- Forget deletes the exact tenant/repository scope and inserts its audit row in one transaction.
- No repository-memory state is cached before or after commit.
- Audit insertion uses one database time value for both timestamps.
- Startup/hourly cleanup is idempotent and safe when multiple service instances run it.
- Catalog publication writes no database state; runtime repository operations write no catalog
  state.

## Data Never Stored

Source code, client files, local paths, repository names/remotes, raw Git metadata, raw prompts,
task queries, caller URLs, secrets, bearer tokens, skill/resource bodies in repository memory, and
repository identifiers in deletion audit records or logs.
