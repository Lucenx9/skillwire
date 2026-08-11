# MCP Tool Contracts

## Public Surface

SkillWire exposes exactly these authenticated MCP tools:

1. `search_skills`
2. `load_skill`
3. `read_skill_resource`
4. `list_repo_memory`
5. `record_skill_outcome`
6. `forget_repo_memory`

There are no MCP prompts, resources, tasks, publication, verification, installation, execution, or
admin capabilities. Catalog maintenance is an offline CLI contract.

All input/output objects are strict: unknown properties are rejected. JSON Schemas in `schemas/`
are generated from the Zod v4 source and checked for drift.

## Authentication and Repository Context

- Every tool requires `Authorization: Bearer <api-key>` before argument-dependent processing.
- The authenticated key determines `accountId`; no MCP argument can select an account.
- Optional repository context is exactly 64 lowercase hexadecimal characters.
- Repository-memory tools and ranking queries access PostgreSQL directly with the combined
  `(accountId, repositoryHash)` predicate.
- No repository-memory response or projection is cached.
- Omitting repository context permits search/load but creates no persistent memory.

## Operation Semantics

### `search_skills`

**Input**: bounded natural-language `task`, optional `repositoryHash`, optional result limit up to 10.

**Output**: ranked compact previews containing skill ID, name, description, capability summary,
exact revision, immutable `trustAtPublication`, and derived `currentAdvisoryStatus`.

**Rules**:

- Never returns instructions, manifests, resource bodies, or raw advisory events.
- Uses deterministic lexical relevance as primary score.
- If repository context exists, reads the bounded usage/outcome projection directly from PostgreSQL
  and applies only the limited specified secondary boost.
- Omits security-revoked revisions and never fetches caller-selected content.

### `load_skill`

**Input**: `skillId`, exact `revision`, optional `repositoryHash`.

**Output**: exact identity/revision, normalized Markdown instructions, bundle SHA-256, complete
published provenance with `trustAtPublication`, top-level `currentAdvisoryStatus`, and complete
resource manifest without resource bodies.

**Rules**:

- Rejects unknown/floating revisions without substitution.
- Verifies the complete bundle before returning content.
- May use only a complete immutable catalog-cache entry keyed by release/revision/bundle hash, and
  re-verifies the bundle before fallback service.
- Returns skill content as inert text and never executes it.
- With a repository hash, directly upserts exact revision usage in PostgreSQL before acknowledging
  the load; without a hash, performs no memory write.

### `read_skill_resource`

**Input**: `skillId`, exact `revision`, exact manifest-declared normalized relative `resourcePath`.

**Output**: exact identity/revision/path, media type, normalized UTF-8 byte length, resource SHA-256,
and only that resource's text.

**Rules**: Rejects absolute, traversal, encoded traversal, backslash, NUL, symlink, undeclared,
cross-revision, binary, oversized, or hash-mismatched resources before returning content.

### `list_repo_memory`

**Input**: required `repositoryHash`.

**Output**: bounded deterministic list of exact skill/revision usage records with first/last used
timestamps, use count, and current outcome.

**Rules**:

- Queries PostgreSQL directly for the authenticated account and supplied hash.
- Returns the same empty shape for an absent scope.
- Never returns task queries, content, paths, raw repository data, or another tenant's records.

### `record_skill_outcome`

**Input**: required `repositoryHash`, `skillId`, exact `revision`, and one of `useful`, `neutral`, or
`unsuccessful`.

**Output**: exact identity/revision and the current outcome.

**Rules**: Replaces the outcome directly in PostgreSQL only for an existing usage row in the same
tenant/repository scope. Unknown usage or invalid outcome is rejected without mutation.

### `forget_repo_memory`

**Input**: required `repositoryHash`.

**Success output**:

```json
{ "forgotten": true }
```

**Rules**:

- In one PostgreSQL transaction, deletes all matching usage/outcome rows and inserts the six-field
  privacy-safe audit record.
- Returns success only after commit.
- Has no cache invalidation step because repository memory is never cached.
- Is idempotent and never returns removed count or prior-existence information.
- Does not affect catalog data, another repository hash, or another account.
- Database failure rolls back and returns `ERASURE_INCOMPLETE` without claiming success.

## Provenance and Canonical Hash Contract

### Text normalization

1. Decode strict UTF-8 and reject invalid sequences/NUL.
2. Remove one leading BOM.
3. Convert CRLF and CR to LF.
4. Apply the specified Unicode normalization.
5. Preserve all remaining bytes, including trailing newline presence.

### Resource hash

`sha256(normalized UTF-8 resource bytes)` as 64 lowercase hexadecimal characters.

### Revision hash

SHA-256 over RFC 8785-compatible canonical JSON containing schema version, skill ID, exact revision,
complete published provenance, normalized instructions, sorted manifest entries, and sorted resource
path/content pairs. `bundleSha256` and derived `currentAdvisoryStatus` are excluded.

## Advisory Status Contract

- `trustAtPublication` is immutable and bundle-hash covered.
- `currentAdvisoryStatus` is derived from the verified version-controlled advisory chain.
- Allowed current values are `available`, `unavailable`, and terminal `revoked`.
- A chain/head/baseline failure makes affected catalog state unavailable; it never rewrites a
  published batch.
- Search omits revoked revisions and load rejects them.

## Tool Failure Contract

MCP errors have a stable bounded `code`, safe `message`, retryability flag, and request ID. They do
not reveal credential status, other tenants, repository existence, source paths, content, SQL, or
internal exceptions.

| Code | Retryable | Meaning |
|------|-----------|---------|
| `UNAUTHENTICATED` | No | Missing/malformed/unknown/expired/revoked key or disabled account. |
| `INVALID_ARGUMENT` | No | Schema, repository hash, task, outcome, or limit failure. |
| `NOT_FOUND` | No | Unknown exact skill/revision or undeclared resource after authentication. |
| `REVISION_UNAVAILABLE` | Yes | Source/cache/advisory integrity cannot provide the exact verified revision. |
| `RESOURCE_REJECTED` | No | Unsafe, binary, oversized, or hash-mismatched resource. |
| `MEMORY_CONFLICT` | No | Outcome target was never loaded in this tenant scope. |
| `ERASURE_INCOMPLETE` | Yes | Authoritative PostgreSQL transaction did not commit. |
| `RATE_LIMITED` | Yes | Authenticated key exceeded the configured service policy. |
| `INTERNAL` | Yes | Safe fallback without protected detail. |
