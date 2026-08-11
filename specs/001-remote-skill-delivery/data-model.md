# Data Model: Remote Skill Delivery MVP

## Model Boundaries

SkillWire has two kinds of state:

1. **Version-controlled catalog state**: reviewed skill metadata, immutable Markdown revisions,
   manifests, and declared text resources packaged with the server. It is not stored in PostgreSQL.
2. **Account state**: accounts, bearer API-key digests, and repository-scoped skill usage stored in
   PostgreSQL.

Repository memory contains no repository record or repository metadata table. The opaque repository
hash appears only on usage rows, so forgetting a repository is one tenant-scoped delete and leaves
no empty repository object behind.

## Domain Entities

### CatalogSkill

| Field | Type | Rules |
|-------|------|-------|
| `skillId` | string | Lowercase kebab case, 1–80 characters, globally unique in the catalog. |
| `name` | string | Human-readable, 1–120 characters. |
| `summary` | string | Discovery-only text, at most 512 characters. |
| `capabilities` | string array | At most 16 normalized discovery terms. |
| `tags` | string array | At most 16 normalized ranking terms. |
| `trustStatus` | `trusted` | The only MVP catalog status. |
| `source` | SourceReference | Server-created provider and logical source reference. |
| `revisions` | SkillRevision array | At least one immutable revision. |

### SkillRevision

| Field | Type | Rules |
|-------|------|-------|
| `skillId` | string | References its catalog skill. |
| `revision` | string | Exact immutable label; floating names such as `latest`, `main`, `master`, and `HEAD` are forbidden. |
| `schemaVersion` | `skillwire-revision-v1` | Selects canonical serialization rules. |
| `instructions` | string | Valid normalized UTF-8 Markdown, at most 256 KiB. |
| `revisionSha256` | lowercase hex | Exactly 64 characters; covers instructions, canonical manifest, and all normalized resources. |
| `manifest` | ResourceManifestEntry array | At most 64 unique entries sorted by logical path. |
| `totalBytes` | integer | Total normalized instructions and resource bytes, at most 2 MiB. |
| `source` | SourceReference | Immutable server-generated provenance reference. |
| `trustStatus` | `trusted` | Copied into each successful load response. |

Identity is the tuple `(skillId, revision, revisionSha256)`. A reused revision label with a different
hash is an integrity failure, never a replacement.

### ResourceManifestEntry

| Field | Type | Rules |
|-------|------|-------|
| `path` | string | Normalized relative POSIX path, unique in the revision, at most 240 characters. |
| `mediaType` | enum | `text/markdown` or `text/plain`. |
| `byteLength` | integer | Normalized UTF-8 size, 0–262,144 bytes. |
| `sha256` | lowercase hex | SHA-256 of the normalized resource bytes. |

Paths are rejected if absolute, empty, contain `.` or `..` segments, backslashes, NUL bytes,
encoded traversal after decoding, or map to a symlink or non-regular file.

### SourceReference

| Field | Type | Rules |
|-------|------|-------|
| `provider` | string | Stable provider name such as `version-controlled`; not supplied by MCP callers. |
| `reference` | string | Provider-owned immutable logical reference; never an absolute local path. |

The application treats source references as opaque. Only the provider adapter interprets them.

### SearchPreview

Contains `skillId`, `name`, `summary`, matching capabilities, `trustStatus`, and one exact
`revision`. It never contains instructions, source internals, the resource manifest, or resource
bodies.

### RequestPrincipal

| Field | Type | Rules |
|-------|------|-------|
| `accountId` | UUID | Derived only from a valid bearer API key. |
| `apiKeyId` | UUID | Public key identifier used for audit and rate limiting. |

Tool inputs never contain an account ID. Use cases receive the principal from authentication
middleware, preventing a caller from selecting another tenant.

## PostgreSQL Tables

### `accounts`

| Column | PostgreSQL type | Constraints |
|--------|-----------------|-------------|
| `account_id` | `uuid` | Primary key. |
| `status` | `text` | `active` or `disabled`; check constraint. |
| `created_at` | `timestamptz` | Required; server time. |

Accounts are provisioned out of band. Teams, organizations, roles, and account profile data are not
part of the MVP.

### `api_keys`

| Column | PostgreSQL type | Constraints |
|--------|-----------------|-------------|
| `api_key_id` | `uuid` | Primary key; public token component. |
| `account_id` | `uuid` | Required foreign key to `accounts`. |
| `secret_digest` | `bytea` | Required 32-byte HMAC-SHA-256 digest; never the token. |
| `created_at` | `timestamptz` | Required. |
| `expires_at` | `timestamptz` | Optional; must be later than creation. |
| `revoked_at` | `timestamptz` | Optional; terminal revocation timestamp. |
| `rotated_from_key_id` | `uuid` | Optional self-reference used for operator audit. |
| `last_used_at` | `timestamptz` | Optional; updated only after successful authentication. |

Indexes: primary-key lookup by `api_key_id`; secondary index on `(account_id, revoked_at)` for
operator key listings. Active means account active, `revoked_at IS NULL`, and `expires_at` absent or
in the future.

### `repository_skill_usage`

| Column | PostgreSQL type | Constraints |
|--------|-----------------|-------------|
| `account_id` | `uuid` | Required foreign key to `accounts`. |
| `repository_hash` | `char(64)` | Required lowercase hexadecimal client-generated SHA-256. |
| `skill_id` | `text` | Required catalog skill identity. |
| `revision` | `text` | Required exact immutable revision label. |
| `revision_sha256` | `char(64)` | Required revision bundle hash. |
| `first_used_at` | `timestamptz` | Required; unchanged after insert. |
| `last_used_at` | `timestamptz` | Required; updated on each remembered load. |
| `usage_count` | `bigint` | Required, starts at 1, increments on remembered load, must remain positive. |
| `outcome` | `text` | Optional; `useful`, `neutral`, or `unsuccessful`. |

Primary key: `(account_id, repository_hash, skill_id, revision)`.

Additional constraints:

- Repository and revision hashes match `^[0-9a-f]{64}$`.
- Floating revision labels are rejected before persistence.
- A primary-key conflict with a different `revision_sha256` is an integrity error; it does not
  update the existing row.
- Index `(account_id, repository_hash, last_used_at DESC, skill_id, revision)` serves listing and
  complete erasure.

This table contains exactly the persistent repository-memory fields authorized by the specification:
account identity, opaque repository hash, immutable skill revision identity, usage timestamps and
count, and optional bounded outcome.

### `schema_migrations`

| Column | PostgreSQL type | Constraints |
|--------|-----------------|-------------|
| `filename` | `text` | Primary key; ordered migration filename. |
| `sha256` | `char(64)` | Hash of the exact migration bytes. |
| `applied_at` | `timestamptz` | Required. |

The migration runner obtains a fixed transaction-level advisory lock, creates this table if absent,
verifies all applied checksums, and applies each pending SQL file in filename order inside its own
transaction. Applied migration files are never edited; corrections use a new migration.

## State Transitions

### Repository usage

```text
absent
  ├─ load without repository hash ───────────────> absent
  └─ load with valid account + repository hash ─> remembered(outcome = null, count = 1)

remembered
  ├─ repeated load ──────────────────────────────> remembered(count + 1, last_used_at updated)
  ├─ valid outcome ──────────────────────────────> remembered(outcome replaced)
  └─ forget repository ──────────────────────────> absent
```

`record_skill_outcome` requires an existing remembered row. `forget_repo_memory` deletes every row
for `(account_id, repository_hash)` in one transaction and is idempotent.

### API key

```text
issued(active) ── expires_at reached ─> expired
       │
       ├─ revoke ────────────────────> revoked
       └─ rotate ─> replacement active; original stays active during overlap, then is revoked
```

Expired and revoked states are terminal. Authentication checks database state on every request, so
revocation takes effect immediately without cache invalidation.

### Catalog revision

```text
unverified ── validate paths/types/sizes + verify all hashes ─> available
     └────── any validation/integrity failure ────────────────> rejected

available ── source failure + verified cached bundle ─────────> available from cache
available ── source/cache integrity mismatch ─────────────────> unavailable
```

Catalog states are process-local and reconstructed from the packaged version-controlled catalog at
startup. No catalog content is written to client locations.

## Transaction Boundaries

- `load_skill` verifies the exact bundle before the memory transaction. If a repository hash exists,
  one parameterized upsert increments count and last-used time only when the persisted revision hash
  matches.
- `record_skill_outcome` updates one row selected by account, repository hash, skill ID, and revision;
  zero affected rows maps to `USAGE_NOT_FOUND`.
- `forget_repo_memory` deletes the tenant/hash scope in one transaction and returns success even for
  zero rows.
- Memory reads always include `account_id` and `repository_hash` predicates and never accept an
  account identifier from MCP input.

## Data Not Stored

Source code, repository paths or URLs, raw Git metadata, file contents, task descriptions, raw
prompts, API-key secrets, authorization headers, skill instructions, skill resources, arbitrary
source URLs, and outcome history are never stored in repository memory.
