# MCP Tool Contracts

## Public Surface

SkillWire advertises exactly six tools:

1. `search_skills`
2. `load_skill`
3. `read_skill_resource`
4. `list_repo_memory`
5. `record_skill_outcome`
6. `forget_repo_memory`

There are no MCP prompts, MCP resources, tasks, sampling, elicitation, installation operations,
execution operations, source-registration operations, or administrative tools.

Every input and successful `structuredContent` output uses the checked JSON Schemas in
[`schemas/`](./schemas/). Zod 4 schemas are the implementation source; contract tests generate JSON
Schema and compare it with these artifacts. All input objects reject unknown properties.

## Authentication Context

Every call arrives with a `RequestPrincipal` created from the HTTP bearer API key. Tool inputs never
accept account ID, API-key ID, permissions, or tenant. An optional `repositoryHash` changes only
repository memory behavior; it never changes authentication.

## Operation Semantics

### `search_skills`

- Accepts a nonblank natural-language `task`, optional repository hash, and optional result limit.
- Trims outer whitespace for ranking but never persists or logs the task.
- Returns at most the requested limit of compact previews; an empty match returns `skills: []`.
- Computes deterministic integer task relevance first. For equal integer relevance, useful prior
  usage adds `0.2`, neutral/unrated adds `0.1`, and unsuccessful/absent adds `0`.
- Reads memory only for the authenticated account and supplied repository hash.
- Never returns instructions, source details, a manifest, or resource bodies.

### `load_skill`

- Requires exact `skillId` and `revision`; no default/fallback/floating resolution exists.
- Verifies the complete canonical revision bundle before returning content.
- Returns core Markdown instructions and complete provenance/manifest, but no resource body.
- When `repositoryHash` is present, atomically inserts or increments remembered usage and returns
  `memoryRecorded: true`.
- When the hash is absent, returns the same skill content and `memoryRecorded: false` without a
  persistence write.

### `read_skill_resource`

- Requires exact skill ID, revision, and one safe manifest-declared logical path.
- Verifies the revision and selected resource hash before returning only that resource.
- Does not require a prior load in the same HTTP process because transport requests are stateless.
- Does not create or update repository memory.

### `list_repo_memory`

- Requires a repository hash and derives account from the bearer key.
- Returns at most 100 usage rows ordered by `lastUsedAt DESC`, then skill ID and revision.
- Omits `outcome` when unrated.
- Returns an empty list for an unknown/erased scope without revealing another tenant's state.

### `record_skill_outcome`

- Requires repository hash, exact skill ID/revision, and one bounded outcome.
- Updates the current outcome only for an existing remembered usage in the authenticated tenant.
- Does not create usage, append outcome history, or alter usage count/timestamps.

### `forget_repo_memory`

- Deletes all remembered loads and outcomes for the authenticated account/hash in one transaction.
- Is idempotent and always returns `forgotten: true` after a successful authorized transaction.
- Does not delete catalog content, API keys, another repository hash, or another account's rows.

## Provenance and Canonical Hash Contract

### Text normalization

- Decode UTF-8 in fatal mode.
- Remove one leading UTF-8 BOM.
- Normalize CRLF and lone CR to LF.
- Preserve all other Unicode code points and trailing LF state; do not apply Unicode normalization.
- Reject NUL bytes and content exceeding byte limits after normalization.

### Resource hash

`sha256` is lowercase hexadecimal SHA-256 over the normalized UTF-8 bytes of that resource.

### Revision hash

Create this logical value with manifest/resources sorted by ascending path:

```text
{
  schemaVersion: "skillwire-revision-v1",
  instructions: <normalized Markdown string>,
  manifest: [
    { path, mediaType, byteLength, sha256 }, ...
  ],
  resources: [
    { path, content: <normalized text string> }, ...
  ]
}
```

Serialize the value with RFC 8785 JSON Canonicalization Scheme, encode as UTF-8, then compute
lowercase hexadecimal SHA-256. The revision hash, source, trust status, skill ID, and revision label
are not fields inside the hashed value. A change to instructions, manifest metadata, resource order
after canonical sorting, or resource content is detected; reordering the source manifest alone is
not a content change.

`load_skill` returns:

- provider-owned immutable `source`
- exact `revision`
- `revisionSha256`
- `trustStatus: "trusted"`
- complete path-sorted `resourceManifest`, including each resource hash and normalized byte length

## Tool Failure Contract

Transport/auth failures occur before MCP tool invocation and follow
[streamable-http.md](./streamable-http.md). Zod input failures use JSON-RPC invalid parameters.
Expected domain failures return an MCP tool result with `isError: true`, one text content block
containing a compact JSON error object, and no successful `structuredContent`.

| Code | Retryable | Meaning |
|------|-----------|---------|
| `SKILL_NOT_FOUND` | No | Skill ID is not in the curated catalog. |
| `REVISION_NOT_FOUND` | No | Exact revision does not exist; no substitution occurred. |
| `RESOURCE_NOT_FOUND` | No | Path is not declared for the exact revision. |
| `CONTENT_REJECTED` | No | Path, text type, schema, or size policy failed. |
| `REVISION_UNAVAILABLE` | Conditional | Integrity failure is non-retryable; temporary provider failure without valid cache is retryable. |
| `USAGE_NOT_FOUND` | No | Outcome target was never loaded for this account/hash. |
| `INTERNAL_ERROR` | Yes | Unexpected failure; response includes request ID only. |

Error object fields are exactly `code`, `message`, `retryable`, and `requestId`. Messages never
contain local paths, URLs, SQL, hashes from another tenant, raw inputs, catalog content, or internal
exception text.

## Schema Notes

- JSON Schema `maxLength` is defense in depth. Runtime policy measures normalized UTF-8 bytes.
- `Revision` schema rejects common floating labels; application validation applies the check
  case-insensitively.
- `ResourcePath` schema is preliminary syntax validation. The provider performs decoding,
  normalization, containment, `lstat`, declaration, length, and hash checks.
- Manifest path uniqueness and lexical ordering are semantic checks covered by contract tests.
