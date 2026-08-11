# Integration and Test Strategy: Remote Skill Delivery MVP

## Test Projects

Vitest uses one configuration with five projects. Unit tests run by default; suites requiring
PostgreSQL or the HTTP server are explicit scripts.

| Project | Scope | External dependencies |
|---------|-------|-----------------------|
| `unit` | Domain rules, ranking, canonicalization, path parsing, token parsing, redaction. | None. |
| `contract` | Zod schemas, generated JSON Schemas, MCP tool registration, structured outputs, errors. | In-process server only. |
| `integration` | SQL migrations/repositories, restart persistence, catalog provider/cache. | PostgreSQL 18. |
| `e2e` | Authenticated Streamable HTTP calls through Hono to real use cases and PostgreSQL. | PostgreSQL 18 and bound test port. |
| `security` | Tenant isolation, SSRF/path/content attacks, auth lifecycle, no-install invariant, log leakage. | PostgreSQL 18; isolated temporary directories. |

Tests use deterministic clocks and fixture IDs. Integration projects run with isolated PostgreSQL
schemas or databases and do not share mutable rows across workers. Database suites run migrations
from empty state before fixtures and clean their own test database afterward.

## Contract Strategy

- Each MCP tool has one strict Zod input and one strict successful `structuredContent` output schema.
- Contract tests generate JSON Schema from Zod and compare it with the checked files under
  `contracts/schemas/`; any drift is an intentional contract change.
- A tool-list golden test asserts exactly six public tools and their descriptions.
- Unknown fields, including URL/source/account fields, fail with invalid parameters.
- Successful tool results contain both concise text content and schema-valid structured content.
- Domain failures use the error codes in `contracts/mcp-tools.md` and omit `structuredContent`.
- Stateless transport tests assert no session ID, no SSE/session state, and 405 for GET/DELETE.
- Unsupported protocol revisions are rejected deterministically.

## Unit Coverage Matrix

| Area | Required cases |
|------|----------------|
| Ranking | Field weights, normalization, stable ties, useful `0.2`, neutral/unrated `0.1`, unsuccessful `0`, memory never crosses a one-point relevance gap. |
| Repository hash | Exact 64 lowercase hex accepted; uppercase, wrong length, whitespace, and nonhex rejected. |
| Canonicalization | Manifest order independence, CRLF/LF equivalence, BOM handling, UTF-8 rejection, single-byte content change changes hash, golden RFC 8785 vectors. |
| Resource paths | Valid nested POSIX paths; absolute, dot segments, encoded traversal, backslashes, drives, NUL, duplicate normalization rejected. |
| API keys | Token grammar, HMAC digest, constant-time compare path, expiry, revocation, disabled account, rotation overlap. |
| Redaction | Every forbidden field absent from serialized logs, nested errors sanitized, repository correlation irreversible without pepper. |
| Outcomes | Null/useful/neutral/unsuccessful transitions; invalid values rejected; update does not create usage. |

Domain, application, authentication, canonicalization, and repository adapter modules require at
least 90% line and branch coverage; the whole service requires at least 80%. Coverage is a backstop,
not a substitute for the named boundary tests.

## PostgreSQL Integration Tests

1. Apply migrations to an empty database and verify schema/constraints/indexes.
2. Re-run migrations and verify no changes.
3. Change a copied applied migration and verify checksum rejection.
4. Start two migration runners and verify advisory-lock serialization.
5. Load one revision twice and verify count, first/last timestamps, and hash-preserving upsert.
6. Attempt the same skill/revision label with a different revision hash and verify integrity failure.
7. Record each outcome and verify replacement without outcome history.
8. Forget one account/hash and verify complete deletion without affecting another hash or account.
9. Restart the service/database connection and verify acknowledged memory persists and erased memory
   does not return.
10. Verify all SQL injection-shaped values remain data through parameterized queries.

## End-to-End Acceptance Matrix

| Scenario | Verification |
|----------|--------------|
| Search previews only | Response validates; no instructions, manifest, or resource body occurs. |
| Exact load | Requested ID/revision, source, trust, bundle hash, instructions, and complete manifest match fixtures. |
| Progressive resource | One declared path returns one body and per-resource hash; no sibling body is returned. |
| Hashless calls | Search/load succeed; list remains unchanged. |
| Remembered load | Load with account/hash creates one usage; repeat increments count. |
| Ranking memory | Equal base relevance sorts useful, then neutral/unrated, then unsuccessful/absent. |
| Outcome | Only three enum values work and only for remembered usage. |
| Erasure | Forget is idempotent and removes every row in the account/hash scope across restart. |
| Cached fallback | Verified exact cache succeeds during provider failure; corrupt/missing cache returns unavailable. |
| Client non-installation | Snapshot a temporary client repo before and after all success/failure/retry/cache calls; byte-for-byte tree is unchanged. |

## Security Failure Matrix

- Missing, malformed, wrong, expired, and revoked bearer tokens return identical 401 responses.
- Two account keys with the same repository hash cannot observe or mutate one another's memory or
  ranking signal.
- Account ID, URL, source, owner/repository/ref, and extra nested input fields are rejected.
- Path attacks cover raw and percent-encoded `..`, double encoding, absolute POSIX/Windows paths,
  backslashes, NUL, long paths, symlinks, and time-of-check/time-of-use replacement in fixtures.
- Size tests cover one byte below, at, and one byte above request, task, instructions, resource,
  manifest count, and bundle limits.
- Revision substitution tests cover unknown revisions, floating labels, altered source content,
  altered manifest, altered resource, and cache poisoning.
- Malicious Markdown contains shell commands, package-manager instructions, hooks, code fences, and
  binary-looking text; assertions prove no execution API is called and content remains text.
- Log-capture tests exercise every failure and assert absence of authorization, token, secret,
  repository hash, task, prompt, local path, instructions, and resource content.
- Rate-limit tests use a deterministic clock and verify 429, `Retry-After`, bounded key state, and no
  use-case invocation after rejection.

## Failure Injection

Adapters expose only deterministic test seams:

- Catalog fixture provider can return unavailable, incomplete, hash-mismatched, oversized, or
  path-invalid bundles.
- Clock controls key expiry, timestamps, and rate-limit windows.
- Repository adapters can fail before or during transactions to verify rollback and safe errors.
- Log sink captures structured events before external serialization.

No general-purpose plugin/mocking framework is added. Tests inject the same small ports used by the
composition root.

## Commands and Release Gate

Planned package scripts:

```text
pnpm test                 # unit + contract
pnpm test:integration     # PostgreSQL integration
pnpm test:e2e             # HTTP/MCP acceptance
pnpm test:security        # adversarial and no-install suites
pnpm test:coverage        # all projects with V8 coverage
pnpm typecheck
pnpm lint
```

A release requires typecheck, lint, every Vitest project, schema drift checks, migration checks, and
the Docker Compose quickstart. Any failure in provenance, isolation, resource safety, persistence,
redaction, no execution, or no-client-installation blocks release regardless of aggregate coverage.
