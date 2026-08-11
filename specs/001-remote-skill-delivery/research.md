# Research: Remote Skill Delivery MVP

## Decision 1: Runtime and package baselines

**Decision**: Target Node.js 24 LTS and strict TypeScript 7 ESM. Use pnpm 11 and commit the lockfile.
Use PostgreSQL 18, Vitest 4, Hono 4, Zod 4, `pg` 8, and the stable MCP TypeScript SDK 2 packages.
Exact patch releases are locked during implementation rather than copied into runtime code.

**Rationale**: Node 24 is the active LTS line on the planning date. MCP SDK 2 is the stable package
line for the 2026-07-28 protocol and requires the split `@modelcontextprotocol/server` and optional
framework adapter packages. PostgreSQL 18 is current and supported through 2030. The chosen major
lines are mutually compatible with Node 24.

**Alternatives considered**:

- Node 26 is Current, not LTS, so it is unsuitable for the production baseline.
- MCP SDK v1 is superseded and conflicts with the requested v2 package split.
- An ORM or query builder would add a second model over a three-table persistence design.

**Sources**:

- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [MCP TypeScript SDK v2 server package](https://www.npmjs.com/package/@modelcontextprotocol/server)
- [MCP TypeScript SDK migration to v2](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
- [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/)
- [Vitest v4 guide](https://v4.vitest.dev/guide/)

## Decision 2: Stateless MCP over Hono

**Decision**: Build a Hono application with `createMcpHonoApp`, mount one `/mcp` endpoint, and use
the SDK v2 per-request handler/server factory in strict stateless mode. Advertise only MCP tools.
Reject unsupported legacy/stateful protocol behavior; do not issue session IDs, expose SSE session
routes, or enable prompts, MCP resources, sampling, elicitation, or tasks.

**Rationale**: The v2 SDK provides a stable per-request stateless handler for the 2026-07-28
protocol. `@modelcontextprotocol/hono` supplies the official thin Hono integration, JSON parsing,
and host-header protection. A new MCP server context per request prevents cross-request principal or
tool state leakage and removes any need for session affinity, Redis, queues, or message routing.

**Alternatives considered**:

- Stateful Streamable HTTP introduces session storage and routing without product value.
- Stdio would require a local installation and is therefore constitutionally invalid.
- Express or Fastify would ignore the user's explicit Hono decision.

**Sources**:

- [MCP v2 server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [MCP v2 stateless handler](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/server/createMcpHandler.html)
- [MCP Hono adapter](https://www.npmjs.com/package/@modelcontextprotocol/hono)
- [Sessionless MCP guidance](https://modelcontextprotocol.io/seps/2567-sessionless-mcp)

## Decision 3: Strict Zod schemas are the contract source

**Decision**: Define every tool input and successful structured output with Zod 4 strict objects.
Reject unknown keys, validate byte-policy constraints after parsing, and generate/compare JSON
Schema artifacts in contract tests. Return both concise text content and `structuredContent` for
successful tool calls.

**Rationale**: Zod 4's `z.strictObject`, `safeParse`, and `z.toJSONSchema` provide one runtime and
static contract source. Strict unknown-key rejection is essential to prevent hidden URL/source
parameters. Separate byte checks are required because JSON Schema string lengths are character
counts, not UTF-8 byte counts.

**Alternatives considered**:

- Handwritten TypeScript interfaces provide no runtime protection.
- Independent handwritten runtime and JSON schemas are likely to drift.
- Permissive objects could silently accept caller-supplied fetch targets.

**Sources**:

- [Zod 4 documentation](https://zod.dev/v4)
- [Zod JSON Schema conversion](https://zod.dev/json-schema)

## Decision 4: Version-controlled catalog behind one provider port

**Decision**: Package an allowlisted catalog index plus eight to twelve immutable skill directories
with the service. Implement one `SkillCatalogProvider` port with preview listing, exact revision
loading, and declared resource reading. The MVP adapter reads the packaged catalog. A GitHub adapter
may later implement the same port using only server-owned allowlisted configuration.

**Rationale**: A checked-in catalog is reviewable, reproducible, deployable without runtime crawling,
and cannot be redirected by MCP input. The explicit provider seam is required by the user, but a
plugin system or provider registry would be speculative. Logical source references rather than URLs
keep the application and MCP contracts provider-neutral.

**Alternatives considered**:

- Database-backed publishing adds workflows that are out of scope.
- Caller-selected URLs create SSRF and violate the constitution.
- Autonomous GitHub crawling is explicitly excluded.

## Decision 5: Canonical revision and resource hashing

**Decision**: Normalize textual files as UTF-8 without BOM and with LF line endings. Reject invalid
UTF-8, NUL bytes, symlinks, and undeclared files. Sort manifest entries by logical POSIX path. Hash
each normalized resource byte sequence with SHA-256. Build a typed revision object containing a
format version, normalized instructions, canonical manifest entries, and each normalized resource;
serialize it with RFC 8785 JSON Canonicalization Scheme and hash those UTF-8 bytes for the revision
SHA-256. The revision hash field itself is excluded from the object.

**Rationale**: The procedure is deterministic across operating systems, has no hash cycle, binds
instructions, manifest metadata, and resource bodies, and still lets a progressively read resource
be checked independently. A format version allows a future hash-format change to require an
explicit new revision.

**Alternatives considered**:

- Hashing files in filesystem enumeration order is nondeterministic.
- Hashing only the instructions fails to bind progressive resources.
- A handwritten generic JSON canonicalizer risks subtle ordering and number-encoding errors.

**Source**:

- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)

## Decision 6: Deterministic lexical ranking with bounded memory boost

**Decision**: Tokenize normalized task text and catalog title, summary, capabilities, and tags.
Compute an integer relevance score from exact token matches with fixed field weights. Apply memory
only after relevance as a fractional tie-break: `0.2` for useful prior usage, `0.1` for neutral or
unrated usage, and `0` for unsuccessful or absent usage. Sort by relevance plus boost, then stable
skill ID and revision.

**Rationale**: With integer relevance and a boost below one, repository history cannot overtake a
skill with even one more relevance point. The algorithm is explainable, deterministic, easy to
contract-test, and appropriate for approximately ten skills without embeddings.

**Alternatives considered**:

- Embeddings and vector search are explicitly excluded.
- A pure history-first sort violates the requirement that relevance remain primary.
- Fuzzy or learned ranking adds tuning and nondeterminism without launch-scale value.

## Decision 7: PostgreSQL and versioned SQL migrations

**Decision**: Use `pg` with parameterized SQL and three application tables: accounts, API keys, and
repository skill usage. Apply ordered SQL migration files transactionally through a small runner
that takes a PostgreSQL transaction-level advisory lock and stores migration filename, SHA-256, and
application time. Applied migration content is immutable; a checksum mismatch fails startup or the
migration command.

**Rationale**: Direct SQL keeps persistence visible for a small schema and satisfies the explicit
versioned-SQL requirement. The advisory lock prevents concurrent deploys from racing, while stored
checksums prevent silent mutation of an applied revision.

**Alternatives considered**:

- An ORM is unnecessary for three stable tables.
- Startup auto-migration couples serving availability to schema changes; deployment uses an
  explicit one-shot migration step instead.
- Shelling out to `psql` would require a database client in the runtime image.

**Sources**:

- [PostgreSQL transaction-level advisory locks](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html)

## Decision 8: High-entropy bearer keys with keyed digests

**Decision**: Issue tokens as a public UUID key ID plus a 32-byte random Base64URL secret. Store only
the key ID and `HMAC-SHA-256(pepper, secret)` digest. Keep the pepper outside PostgreSQL, compare
digests with `timingSafeEqual`, and never cache authorization across requests. Allow multiple active
account-wide keys for overlap: rotation creates a replacement, then revocation timestamps the old
key. Revoked or expired keys fail on the next request. Provisioning is an out-of-band operator CLI,
not an MCP tool or web UI.

**Rationale**: Random 256-bit API keys do not need password-style slow hashing; a keyed digest
prevents a database-only compromise from validating stolen candidates, supports indexed lookup by
public ID, and uses the Node standard library. Per-request database checks make revocation immediate.

**Alternatives considered**:

- Plain hashes omit defense against a database-only compromise.
- Argon2 is appropriate for low-entropy passwords but adds cost and a native dependency for random
  machine credentials.
- A single replace-in-place key prevents safe rotation overlap.

**Source**:

- [Node.js crypto HMAC and timing-safe comparison](https://nodejs.org/api/crypto.html)

## Decision 9: Structured logging with allowlisted fields

**Decision**: Use Pino JSON logs. Log only typed, allowlisted event fields and never serialize raw
HTTP requests, MCP arguments, tool outputs, catalog bodies, or database rows. Configure explicit
redaction for authorization headers, tokens, secrets, database URLs, repository hashes, and nested
error causes. Derive a separate non-reversible repository correlation value with HMAC when an audit
event requires correlation; never log the raw hash.

**Rationale**: Allowlisting prevents new payload fields from bypassing redaction. Pino's path
redaction is a second defense and structured request IDs support auditing without capturing private
content.

**Alternatives considered**:

- Logging full request objects creates a direct secret and prompt leak.
- Plain console strings are difficult to query and redact reliably.
- Metrics and distributed tracing are deferred because the MVP is a single service and structured
  audit logs satisfy the current observability contract.

**Sources**:

- [Pino](https://github.com/pinojs/pino)
- [Pino redaction](https://github.com/pinojs/redact)

## Decision 10: Container and test topology

**Decision**: Use one multi-stage Dockerfile and one Compose file with PostgreSQL, a one-shot
migration service, and SkillWire. Compose gates migration on database health and the app on migration
success. Vitest projects separate unit, contract, integration, and security suites; integration uses
the Compose PostgreSQL service and security suites exercise the real MCP boundary.

**Rationale**: This mirrors the production process without introducing an orchestration platform,
queue, or cache service. Separate Vitest projects keep fast logic tests independent from database and
transport suites while retaining one runner and configuration.

**Alternatives considered**:

- Testcontainers adds another orchestration dependency when Compose is already required.
- A monorepo is explicitly excluded.
- Redis, queues, and multiple application services violate MVP scope.

**Sources**:

- [Docker Compose health-based startup](https://docs.docker.com/compose/how-tos/startup-order/)
- [Docker Compose secrets](https://docs.docker.com/reference/compose-file/secrets/)
- [Vitest projects](https://v4.vitest.dev/guide/projects)
- [Vitest coverage](https://v4.vitest.dev/guide/coverage)

## Resolved Questions

There are no remaining unresolved research questions. Exact application limits, ranking boosts,
canonical hash format, API-key lifecycle, supported protocol behavior, database/migration strategy,
and deployment topology are fixed above and reflected in the Phase 1 artifacts.
