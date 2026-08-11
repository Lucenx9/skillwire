# Research: Remote Skill Delivery MVP

All implementation questions are resolved. Links point to primary project or vendor documentation.

## Decision 1: Node.js 24, TypeScript 6, pnpm, and typed linting

**Decision**: Use Node.js 24 LTS, strict ESM TypeScript 6.x, pnpm with a frozen lockfile, ESLint flat
configuration with type-aware `typescript-eslint`, and `tsx` as a development dependency for the two
catalog administration commands.

**Rationale**: The selected runtime is active LTS, TypeScript 6 supplies the requested strict compiler
baseline, pnpm provides reproducible dependency resolution, and `tsx` runs the TypeScript CLI without
adding a separate build-only command path.

**Alternatives considered**: CommonJS, npm, Bun, untyped linting, or compiling administration
commands separately. These would diverge from the established project direction or duplicate build
paths.

**Sources**:

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [TypeScript 6 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
- [typescript-eslint typed linting](https://typescript-eslint.io/getting-started/typed-linting/)
- [tsx documentation](https://tsx.is/)

## Decision 2: Stateless MCP SDK v2 over Hono

**Decision**: Expose exactly six tools through the MCP TypeScript SDK v2 and
`@modelcontextprotocol/hono`, using a fresh stateless Streamable HTTP request context and Zod v4 as
the executable schema source.

**Rationale**: The v2 SDK separates server and Hono packages, supports stateless HTTP servers, and
uses public Zod v4 schemas. Hono host validation and strict unknown-field rejection support the
untrusted-caller boundary.

**Alternatives considered**: Stateful MCP sessions, stdio as the service transport, direct Hono
protocol implementation, prompts/resources in addition to tools, or the v1 SDK. None is required by
the six-tool contract.

**Sources**:

- [MCP TypeScript SDK server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [MCP SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
- [MCP server examples](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/server)
- [Zod v4](https://zod.dev/v4)

## Decision 3: Modular monolith with scaffolded then final composition

**Decision**: Keep domain, application ports/use cases, catalog adapters, PostgreSQL adapters,
authentication, lifecycle, observability, and MCP transport in one package. Create only a compile-safe
composition scaffold initially; complete `composition.ts` after all providers, stores, use cases,
schedulers, readiness state, and handlers exist.

**Rationale**: The scaffold permits early boundary checking without pretending unavailable concrete
dependencies can already be wired. Final composition remains the only place adapters meet.

**Alternatives considered**: Final composition during foundation work, service locator access from
handlers, monorepo packages, or microservices. The first is incorrectly ordered and the others add
MVP scope.

## Decision 4: Immutable inputs and evaluation fixtures precede behavior

**Decision**: Commit inventory, all ten instruction/resource bundles, provenance, independent
canonical/hash fixtures, GitHub API fixtures, the search corpus, and the journey matrix before
implementing publication, ranking, or journey behavior evaluated against them.

**Rationale**: Frozen inputs preserve the mandated publication order and reduce the risk that
evaluation cases are selected to match an already-written ranker.

**Alternatives considered**: Generate fixtures from implementation output or author evaluation cases
after tuning. Both weaken independent verification.

## Decision 5: Atomic create-only launch publication is one directory

**Decision**: `catalog:publish` validates the complete ten-skill batch in memory, then atomically
creates the exclusive `catalog/releases/.publish-claim` directory. While holding that fail-closed
claim, it rescans all published revision identities, stages `release.json` and ten per-revision
records in a sibling directory, syncs the complete stage, and performs one same-filesystem rename to
a previously absent `catalog/releases/<release-id>/` path. It reports an outcome for every revision.
An existing or stale claim rejects the run; it is never reclaimed automatically.

**Rationale**: Exclusive directory creation serializes supported publishers from duplicate scanning
through visibility, closing the absence-check/rename race. A single directory rename then makes the
full batch visible at once. A claim left by a crashed process blocks publication until an operator
proves no publisher is active and removes that exact claim outside the CLI.

**Alternatives considered**: An unlocked absence precheck followed by rename, ten independent
`revision.json` writes, overwrite-in-place, a database publication table, automatic stale-claim
recovery, or compensating rollback. These introduce a race, partial visibility, mutation, a second
catalog authority, unsafe concurrent recovery, or non-atomic observation.

**Source**:

- [Node.js filesystem rename API](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath)

## Decision 6: One CLI, two subcommands, separate capabilities

**Decision**: `src/catalog/admin-cli.ts` exposes exactly `publish` and `verify`. Package scripts use
`tsx`. The publisher is the only catalog writer. The verifier imports no writer or PostgreSQL code,
has no repair mode, and returns structured per-revision and release checks.

**Rationale**: One explicit entrypoint resolves command wiring while capability separation makes
read-only verification enforceable through imports, filesystem permissions, write interception, and
command contract tests.

**Alternatives considered**: An unbounded admin CLI, runtime MCP administration, a verifier that
repairs drift, or undocumented direct script execution. Each weakens scope or auditability.

## Decision 7: Latest published GitHub release is the advisory authority

**Decision**: Non-genesis CI fully paginates GitHub's release-list endpoint, retains releases with
`draft: false` and a valid `published_at`, and selects the unique greatest `published_at`. Published
prereleases remain eligible. A tie for greatest publication time fails closed. CI resolves the
selected release tag through the exact `refs/tags/<tag>` reference, recursively peels annotated tag
objects to a commit, and requires exactly 40 lowercase hexadecimal characters. That SHA must equal
`previousReleaseCommit` in the locally verified candidate release metadata. CI then retrieves the
global prior advisory chain through the Contents API with `ref` set to that exact SHA.

**Rationale**: This implements “latest published, non-draft” literally. GitHub's release list exposes
`draft`, `prerelease`, and `published_at`; its `/latest` shortcut would instead exclude prereleases
and order full releases by `created_at`. A release tag may be lightweight or annotated, so the tag
reference must be peeled to its commit. Fetching the single global advisory path by the resulting
immutable commit avoids mutable branches, ambiguous prior-release directories, and local-history
assumptions.

**Genesis rule**: Genesis explicitly stores `genesis: true` and `previousReleaseCommit: null`. CI
must successfully access and fully paginate the repository's release list and prove there is no
non-draft release, including no prerelease. The local verifier proves there is no earlier published
batch and that the candidate advisory chain is an initial chain (empty, or starting at sequence 1
with the zero previous-event hash). A 404 or unavailable GitHub API is not accepted as evidence that
the release list is empty.

**Failure rule**: Missing token/repository access, incomplete pagination, selected release,
unambiguous publication timestamp, tag reference, tag object, exact commit, valid candidate
metadata, or exact-commit prior chain fails closed. Merge bases, branch names, and optional local
fallbacks are prohibited.

**Alternatives considered**: GitHub's `/releases/latest` shortcut, merge-base comparison, a
caller-provided ref, branch names, release `target_commitish`, or a locally available tag. The
shortcut does not implement the requested prerelease/publication-time semantics; the others can be
mutable, ambiguous, or absent in shallow CI history.

**Sources**:

- [GitHub REST: list releases](https://docs.github.com/en/rest/releases/releases#list-releases)
- [GitHub REST: get a Git reference](https://docs.github.com/en/rest/git/refs#get-a-reference)
- [GitHub REST: get an annotated tag](https://docs.github.com/en/rest/git/tags#get-a-tag)
- [GitHub REST: get repository content](https://docs.github.com/en/rest/repos/contents#get-repository-content)

## Decision 8: Cache only verified immutable catalog bundles

**Decision**: Permit one bounded in-process catalog cache keyed by release ID, exact revision, and
verified bundle hash. Admit only complete verified bundles and re-verify before serving fallback
content. Do not cache repository memory, API-key status, audit rows, or mutable advisory projections.

**Rationale**: Immutable bundle identities need no invalidation protocol. Removing mutable
repository-memory caching removes stale reads, scope locks, cache failure modes, and the earlier
single-process deployment restriction.

**Alternatives considered**: Repository-memory cache, Redis, database query cache, or no catalog
cache. Mutable caches add coordination; no catalog cache would remove the specified verified-source
fallback.

## Decision 9: PostgreSQL is the only repository-memory authority

**Decision**: Every search boost, load upsert, list, outcome replacement, and forget operation uses
tenant-scoped parameterized PostgreSQL statements. `forget_repo_memory` deletes usage and inserts the
privacy-safe audit record in one transaction and returns only after commit.

**Rationale**: Direct database access makes persistence, isolation, erasure, and restart behavior
observable at one boundary. Idempotent SQL handles retries without process-local serialization.

**Alternatives considered**: Repository cache plus invalidation, distributed locks, Redis, database
replicas, or deletion journals. They are unnecessary or explicitly excluded.

**Sources**:

- [PostgreSQL transaction processing](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)

## Decision 10: Logical audit expiry is absolute; physical cleanup is availability-qualified

**Decision**: Use one database timestamp for `created_at` and `expires_at = created_at + interval
'30 days'`. Every audit query includes `expires_at > database_now`. Run the idempotent delete for
`expires_at <= database_now` before readiness on startup and hourly thereafter.

**Rationale**: Query filtering makes logical expiration unconditional. With continuous service and
database availability, hourly cleanup bounds physical delay to one hour. During database
unavailability no deletion can be guaranteed; after recovery, readiness remains false until startup
cleanup succeeds.

**Alternatives considered**: Claiming an unconditional physical bound, returning expired rows until
cleanup, operator-managed backup deletion, or a separate worker/queue. The first is impossible
during downtime and the rest violate privacy or scope.

## Decision 11: Bearer API keys remain non-recoverable and immediately revocable

**Decision**: Parse a public key identifier plus high-entropy secret, store only a keyed digest,
compare in constant time, and check account/key expiry or revocation on every request without auth
caching. Redact authorization values and repository identifiers recursively.

**Rationale**: Database lookup on each request gives revocation a clear boundary and avoids another
mutable cache.

**Alternatives considered**: Plaintext keys, reversible encryption, auth caching, JWT tenant claims,
or repository hashes as credentials. These weaken revocation or isolation.

## Decision 12: Test layers have non-overlapping responsibilities

**Decision**: Use Vitest projects for unit, contract, integration, end-to-end, evaluation, and
security suites. Shared parameterized fixtures own repeated matrices; higher layers assert only the
additional boundary they introduce.

**Rationale**: Clear ownership removes duplicate transport/security matrices while preserving the
constitution's required evidence. PostgreSQL integration and full HTTP journeys remain separate.

**Alternatives considered**: One undifferentiated test suite, repeating all failure cases at every
layer, or shared-runner timing gates. These obscure failures or add noise.

**Sources**:

- [Vitest projects](https://vitest.dev/guide/projects)
- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions)
- [Docker Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)

## Decision 13: Performance measurement remains informational

**Decision**: Keep a versioned operation mix, result schema, raw-result hash, cold/warm catalog-cache
profiles, and reproducible Compose environment. CI validates inputs and report shape but does not run
a timing release gate.

**Rationale**: The MVP gathers comparable evidence without turning provisional measurements into a
contract.

**Alternatives considered**: Fixed p95 thresholds, shared-runner timing assertions, or no
measurement method. The first two are unstable; the last loses useful evidence.
