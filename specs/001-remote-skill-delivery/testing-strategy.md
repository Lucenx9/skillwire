# Test, Evaluation, and Integration Strategy

## Suite Ownership

Vitest projects are separated by responsibility, not merely directory.

| Project | Owns | Must not duplicate |
|---------|------|--------------------|
| `unit` | Pure functions and isolated domain objects. | HTTP, real PostgreSQL, CLI process, complete MCP journeys. |
| `contract` | Zod/JSON schemas and observable MCP, HTTP, and admin-CLI boundaries. | SQL persistence semantics or adversarial matrices owned by security. |
| `integration` | Real PostgreSQL, migrations, transactions, cleanup/readiness, and composed internal service. | Full external journey and client-filesystem assertions. |
| `e2e` | Complete authenticated MCP journeys and no-client-write behavior. | Exhaustive low-level validation variants. |
| `security` | Adversarial authentication, isolation, GitHub baseline, paths, SSRF, limits, and execution attempts. | Happy-path journey repetition. |
| `evaluation` | Deterministic threshold calculation over frozen product fixtures. | Unit scoring internals already covered by unit tests. |

Shared parameterized fixtures define a case once. Each suite asserts only the additional property
introduced at its layer.

## Fixture-First Order

Before evaluated behavior is implemented, version control contains:

1. Exact ten-skill inventory, instructions, resources, and provenance.
2. Canonical revision golden vector and corrupt variants independently reviewed against the format.
3. Advisory chains for valid genesis, valid non-genesis append, mutation, deletion, insertion, and
   reorder.
4. GitHub API responses for fully paginated empty/nonempty release lists, published prereleases,
   equal latest publication timestamps, lightweight tags, annotated tag/reference objects,
   unavailable/malformed objects, and exact-commit global advisory content.
5. Search corpus with at least 30 cases and three per launch skill.
6. Journey matrix with at least 20 cases and optional exact resource paths.
7. Repository scopes, API keys, audit timestamps, and monitored client-tree fixture.

`tests/unit/evaluation/fixture-validation.test.ts` rejects malformed IDs, unknown skills, duplicate
cases, missing skill coverage, invalid paths, and incomplete GitHub/advisory fixtures before any
threshold runner executes.

## Unit Tests

Unit tests own:

- strict construction of the seven catalog domain types and release records;
- UTF-8 normalization, RFC 8785-compatible canonicalization, resource/bundle hashes, and golden
  vectors;
- advisory event hash, link, sequence, terminal revocation, and status folding;
- path normalization/containment decisions over abstract file facts;
- lexical score components, stable ties, and bounded outcome boost;
- repository hash, usage, and outcome domain rules without storage;
- API-key parsing/digest/constant-time comparison primitives;
- redaction and allowlisted event construction;
- fixture/corpus structural validation.

They do not instantiate Hono, the MCP SDK, PostgreSQL, the CLI process, or a filesystem catalog.

## Contract Tests

### MCP and HTTP

One file per tool validates strict input/output shape, unknown-field rejection, both trust fields,
bounded safe errors, and omitted content. `streamable-http.test.ts` owns methods, headers, Host,
statelessness, HTTP/MCP status translation, and unsupported capability absence.

Contract tests use fake ports. They do not assert SQL, restart, or cross-tenant database behavior.

### `catalog:publish`

Run the real `pnpm catalog:publish` command against isolated filesystem fixtures and assert:

- exact two-subcommand CLI grammar and structured output schema;
- complete ten-revision success result;
- one final atomic release directory with release plus ten records;
- invalid inventory/content/provenance/hash/advisory failure before visibility;
- existing release path rejection;
- any previously published revision-identity rejection;
- fail-closed existing/stale publication claim;
- two concurrent publishers produce exactly one complete winner and one ten-revision rejection;
- injected failure after each staging step leaves no visible final batch;
- post-rename claim-cleanup failure reports the batch as created and leaves later publication safely
  blocked;
- input files and PostgreSQL remain unchanged.

### `catalog:verify`

Run the real `pnpm catalog:verify` command with write APIs denied and no database service:

- complete valid release and ten per-revision results;
- canonical/resource/release/advisory drift detection;
- no repair behavior;
- a present publication claim returns invalid without mutation;
- workspace snapshot unchanged on success and failure;
- no PostgreSQL import/connection attempt;
- structured output and exit codes.

GitHub response variation belongs to the security suite; the contract suite checks only request and
result boundaries with one valid baseline fixture.

## PostgreSQL Integration Tests

Use one disposable authoritative database with versioned migrations.

- Migration checksums and concurrent migration serialization.
- API-key lifecycle persistence and immediate database-observed revocation.
- Usage upsert uniqueness, timestamps, count, and exact revision binding.
- Direct PostgreSQL list/ranking projection with account/repository predicates.
- Outcome replacement and missing-usage rejection.
- Forget deletion plus six-field audit insertion in one transaction.
- Rollback on delete/audit/commit failure and idempotent lost-response retry.
- No repository-memory cache module, query bypass, invalidation stage, or secondary authority.
- Restart persistence and post-erasure non-resurrection.
- Every audit read filters `expires_at > database_now`.
- Boundary behavior immediately before, at, and after expiration.
- Startup cleanup before readiness and hourly idempotent deletion.
- Multiple service instances may run cleanup concurrently without incorrect results.
- After simulated database downtime, readiness remains false until cleanup succeeds.

The physical one-hour assertion uses a continuously available service/database fixture. Downtime
tests assert cleanup-before-readiness, not an impossible deletion bound while PostgreSQL is absent.

## End-to-End Tests

Use the official MCP client over the running Streamable HTTP endpoint:

1. Search returns compact ranked previews in a representative complete HTTP journey.
2. Load returns exact immutable content/provenance and records usage only with repository context.
3. Resource read returns exactly one declared verified text resource.
4. Repository memory survives restart and remains isolated by account/hash.
5. Outcome replacement and constant-shape erasure work through all six MCP tools.
6. One representative catalog-covered task completes with one search, one load, and at most one
   resource read; aggregate matrix scoring remains solely in the evaluation suite.
7. A monitored client tree remains byte/type/mode identical across normal, failure, retry,
   unavailable-source, valid/corrupt catalog-cache, authentication, rate-limit, and erasure journeys.

The first check asserts preview-only response boundaries for a representative journey; it does not
recalculate the search corpus threshold. The no-client-write harness is implemented once and
parameterized with journey callbacks; other
suites do not repeat its filesystem matrix.

## Security Tests

### Authentication and isolation

- Missing, malformed, unknown, expired, revoked, and disabled-account credentials share one failure
  shape.
- Two accounts with the same repository hash and two hashes in one account never cross-read or
  mutate PostgreSQL rows.
- Raw hashes, bearer values, tasks, content, SQL, and paths never appear in logs or audit rows.

### GitHub advisory baseline

Parameterized fixtures cover:

- valid explicit genesis with accessible, fully paginated releases, zero non-draft releases, no
  earlier local batch, and an initial chain;
- genesis rejected when any non-draft release—including a prerelease—exists or the local chain is
  not initial;
- valid uniquely latest non-draft release by `published_at` with lightweight tag;
- valid latest published prerelease and one or more annotated tag objects peeled to a commit;
- missing/unavailable GitHub token, repository, release page, selected release, tag, tag object,
  exact commit, candidate release metadata, or prior advisory bytes;
- incomplete pagination, malformed/missing publication timestamp, and a tie for greatest timestamp;
- malformed/non-40-character commit, tag cycle, and non-commit terminal object;
- `previousReleaseCommit` mismatch;
- prior event mutation, deletion, insertion, reorder, broken link, or head mismatch;
- proof that no merge-base, branch, `target_commitish`, or fallback request is attempted.

Every failure is closed and performs no catalog/database write.

### Content and transport

- Caller URL/source/ref fields are rejected recursively before provider/network access.
- Raw/encoded traversal, absolute paths, backslashes, NUL, symlink, TOCTOU, cross-revision,
  undeclared, binary, invalid UTF-8, and size boundaries fail safely.
- Executable-looking Markdown remains inert; production imports cannot invoke child processes, VM,
  package managers, installers, or catalog-driven dynamic imports.
- Host, body, task, content, response, deadline, and rate boundaries are adversarially tested.

## Evaluation Runners

### Search

Validate at least 30 cases and at least three per launch skill, then calculate:

```text
topThreeSuccess = matchingTopThreeCases / allValidCases
```

Require `topThreeSuccess >= 0.90`. Invalid cases fail the fixture, never leave the denominator.

### Three-call journey

Validate at least 20 cases, execute exactly one search and one load plus zero/one resource read, and
require at least 90% to select the expected skill/resource within that budget.

Evaluation runners do not modify fixtures, tune ranking, or write catalog/repository state except the
explicit repository-context behavior required by a journey.

## GitHub Actions

Required jobs:

1. formatting check;
2. type-aware lint;
3. strict typecheck;
4. unit;
5. contract and schema drift;
6. evaluation thresholds;
7. PostgreSQL integration;
8. end-to-end;
9. security;
10. Docker/Compose and quickstart validation;
11. read-only `catalog:verify` with `contents: read` and mandatory GitHub release baseline.

CI never invokes `catalog:publish`. Manifest-changing setup work is sequential; jobs consume the
committed frozen lockfile.

## Informational Measurement

CI validates operation-mix and result schemas but does not assert latency. Manual cold/warm
measurements use the separate benchmark Compose profile and cannot change any required job result.
