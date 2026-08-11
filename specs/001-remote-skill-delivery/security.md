# Security Decisions: Remote Skill Delivery MVP

## Security Invariants

1. All six MCP tools require a valid account-wide bearer API key.
2. Account identity comes only from authentication context, never from tool input.
3. Repository memory is always addressed by `(accountId, repositoryHash)`.
4. Catalog inputs are server-owned and allowlisted; no MCP schema contains a URL or source field.
5. Catalog data is returned as validated text and is never executed or installed.
6. An exact revision is returned only after complete bundle verification.
7. Raw secrets, repository hashes, task text, instructions, resources, and prompts never enter logs.

## Trust Boundaries

| Boundary | Untrusted side | Trusted side | Required control |
|----------|----------------|--------------|------------------|
| HTTP edge | Network caller and headers/body | Hono/MCP request context | Host validation, body limit, bearer auth, rate limit, strict schema. |
| MCP adapter | Tool name and arguments | Application use case | Only six registered tools; strict input/output validation; safe error mapping. |
| Catalog provider | Version-controlled skill text/resources | Verified revision cache | Allowlisted index, safe paths, UTF-8/text checks, size limits, hashes. |
| Persistence | Caller-selected repository hash | Tenant-scoped SQL | Principal-derived account ID, parameterized predicates, transactions, constraints. |
| Observability | Errors and request metadata | Structured log sink | Allowlisted fields, explicit redaction, no raw payload serialization. |
| Future provider | Remote source responses | Provider adapter | Server-owned source refs, host allowlist, redirect revalidation, byte/time limits. |

## Bearer API Keys

### Token format and storage

- Token format: `swk_<api-key-uuid>.<base64url-secret>`.
- The secret is 32 cryptographically random bytes and is shown once at issuance.
- PostgreSQL stores the public UUID and `HMAC-SHA-256(apiKeyPepper, secret)` only.
- The pepper is a high-entropy deployment secret loaded from a mounted secret file; it is never in
  the database, repository, image, logs, or command arguments.
- Authentication parses the public UUID, fetches one active account/key row, recomputes the digest,
  checks it with `timingSafeEqual`, then updates `last_used_at`.
- Missing, malformed, expired, revoked, disabled-account, and digest-mismatch cases all return the
  same HTTP 401 response with `WWW-Authenticate: Bearer` and no account-existence signal.

### Rotation and revocation

- The operator CLI can create multiple active keys for an account; all have the same account-wide
  authorization and no role or repository scope.
- Rotation creates a new key linked by `rotated_from_key_id`. Both keys may work during an explicit
  operational overlap; the operator then revokes the old key.
- Revocation sets `revoked_at` and is terminal. No authentication result is cached, so the next
  request fails.
- Key creation output is never replayable. Losing a token requires rotation, not secret recovery.
- Account/key management is not exposed through MCP or HTTP and has no web UI.

## Tenant Isolation

- Tool schemas contain no `account_id`; middleware supplies an immutable `RequestPrincipal`.
- Application use cases require the principal and pass its account ID to every memory repository
  method.
- Every memory select, insert, update, and delete includes `account_id` and `repository_hash`.
- Composite keys and unique constraints include `account_id`.
- Supplying the same repository hash under another key creates or reads only that other account's
  namespace.
- Empty list and idempotent forget responses do not reveal whether another tenant owns the same hash.
- Security tests exercise two accounts with identical repository hashes and revisions for all memory
  operations and ranking.

PostgreSQL row-level security is not added in the MVP. The application uses one database role, so
RLS would require transaction-local tenant state on every pooled connection and add a second policy
system. Tenant-aware repository interfaces, SQL predicates, composite constraints, and boundary
tests are the enforced control. Reconsider RLS only with a separate multi-tenant hardening spec.

## SSRF Prevention

- No MCP input or shared application type accepts a URL, hostname, repository owner, or network
  location.
- The MVP provider reads only files listed in the packaged `catalog/catalog.json`; it performs no
  outbound network request.
- `SourceReference` is created by providers and is output-only.
- The future GitHub provider port accepts a server configuration identifier, not a caller value.
  Its eventual implementation must allowlist host, owner, repository, root path, and immutable
  commit; disable redirects or validate every redirect target; reject private/link-local addresses;
  and enforce response byte and time limits. That provider is not implemented by this feature.
- Strict Zod objects reject unknown fields such as `url`, `source`, `repository`, or `ref`.

## Resource Path Safety

Manifest ingestion performs these checks before any content is available:

1. Decode once and reject malformed percent encodings.
2. Require a relative POSIX path no longer than 240 characters.
3. Reject empty, `.`, and `..` segments, leading slash, backslash, NUL, drive prefix, and duplicate
   normalized paths.
4. Join only beneath the selected immutable revision root.
5. Resolve the real path and confirm it remains beneath that root.
6. Use `lstat` and reject symlinks and non-regular files.
7. Require the path to appear in the canonical manifest with the expected media type, byte length,
   and SHA-256.

`read_skill_resource` resolves by manifest entry, never by directly passing caller input to a file
API.

## Content and Execution Safety

- Accept only UTF-8 Markdown instructions and declared `text/markdown` or `text/plain` resources.
- Decode with fatal UTF-8 handling; remove a leading BOM for canonicalization; normalize CRLF/CR to
  LF; reject NUL bytes.
- Enforce 256 KiB per instructions/resource, 64 resources, and 2 MiB per revision before caching.
- Do not import, evaluate, compile, render, spawn, invoke, or install catalog content.
- Production dependencies and code must not expose `child_process`, `vm`, dynamic import from catalog
  values, package-manager execution, hooks, or writable client paths.
- Code examples inside Markdown remain inert string content.

## Revision Integrity and Substitution Prevention

- Requests identify both stable skill ID and exact revision; `latest`, branches, and fallback
  resolution are rejected.
- Resource reads identify the same exact skill/revision and a declared manifest path.
- The provider verifies every resource hash and the RFC 8785 canonical bundle hash before returning
  instructions or populating cache.
- A revision label observed with a different bundle hash is quarantined as unavailable.
- Source failure may use only a complete cached bundle for the exact requested revision after
  re-verification. It never falls forward or backward to another revision.
- Search results are derived from the same verified catalog index and contain an exact loadable
  revision.

## HTTP and Abuse Controls

- The service accepts MCP POST requests only; stateless GET/DELETE session operations return 405.
- Host-header allowlisting is mandatory through `createMcpHonoApp`, including explicit production
  hosts when binding beyond loopback.
- Request body limit is 64 KiB and content type must be JSON accepted by the SDK transport.
- Per-key rate limit is 120 requests/minute with burst 30; rejected calls return HTTP 429 and
  `Retry-After` before tool execution.
- The limiter stores only API-key UUID and counters in a bounded process-local map. This is valid for
  the single-instance MVP; no Redis or distributed quota is introduced.
- Request timeout is 10 seconds. Provider reads and database statements must honor the remaining
  deadline.
- CORS is disabled by default because the MVP has no browser client.

## Logging and Audit

Allowed event fields are: timestamp, level, event name, request ID, MCP tool name, account ID,
public API-key ID, non-reversible repository correlation, skill ID, revision, provider name, outcome,
duration, result code, retryable flag, and bounded safe error class.

Forbidden fields include authorization headers, API-key secrets/digests/pepper, database URLs,
repository hashes, task descriptions, MCP arguments, prompts, instructions, manifest bodies,
resource paths or bodies, local paths, Git metadata, and raw errors containing request data.

Pino explicit redact paths cover forbidden keys as defense in depth, but event constructors must
allowlist fields first. Authentication failures omit account information. Audit events include key
create/rotate/revoke, auth rejection, rate limiting, catalog integrity failure, memory outcome, and
memory erasure; they never include the raw repository hash.

## Failure Disclosure

| Failure | External behavior |
|---------|-------------------|
| Missing/invalid/revoked bearer key | HTTP 401, identical body, no MCP processing. |
| Rate limit | HTTP 429 with retry guidance, no tool execution. |
| Oversized HTTP body | HTTP 413, no parsing or tool execution. |
| Unknown skill/revision/resource | Stable non-retryable tool error without filesystem/source detail. |
| Integrity or source/cache failure | `REVISION_UNAVAILABLE`, retryable only for source unavailability. |
| Invalid path/content/schema | Non-retryable validation/content-policy error. |
| Missing remembered usage for outcome | `USAGE_NOT_FOUND`, no mutation. |
| Unexpected error | Generic internal tool error plus request ID; details only in redacted server log. |

## Required Security Tests

See [testing-strategy.md](./testing-strategy.md). Release is blocked on SSRF-field rejection, path
traversal variants, symlink rejection, size boundaries, revision substitution, hash mismatches,
cross-account memory access, revoked keys, redaction assertions, inert malicious skill content, and
no-client-write tests.
