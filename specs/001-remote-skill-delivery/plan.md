# Implementation Plan: Remote Skill Delivery MVP

**Branch**: `001-remote-skill-delivery` | **Date**: 2026-08-11 | **Spec**:
[spec.md](./spec.md)

**Input**: Updated feature specification and SkillWire constitution.

## Summary

Build SkillWire as one strict TypeScript modular monolith exposing exactly six MCP tools over
stateless Streamable HTTP. Search returns ranked previews, load returns one exact immutable
revision's instructions and manifest, and resource reads return one declared textual resource.
Catalog content is delivered only through MCP responses and is never installed or executed on the
client.

The exact ten-skill launch catalog is published offline as one create-only atomic batch. The
`src/catalog/admin-cli.ts` entrypoint has exactly `publish` and `verify` subcommands, exposed as
`pnpm catalog:publish` and `pnpm catalog:verify` through `tsx`. Publication validates every input and
stages all ten immutable revision records before one atomic directory rename; no partial batch is
visible. Verification reads the complete catalog and release state without any filesystem or
database write capability.

Repository memory is always read and written directly in one authoritative PostgreSQL database.
There is no repository-memory cache, cache port, invalidation path, scope lock, or related deployment
constraint. The only application cache contains complete, verified immutable catalog bundles keyed
by release and bundle hash.

Advisory CI fully paginates GitHub releases and uses the unique latest non-draft release by
`published_at` as the previous-release authority, including published prereleases. It resolves that
release's tag to an exact 40-character commit SHA, compares it with
`previousReleaseCommit`, and retrieves the previous advisory chain at that exact commit. Genesis is
accepted only when the fully paginated GitHub release list contains no non-draft release, there is
no earlier local batch, and the candidate advisory chain is initial.

## Technical Context

**Language/Version**: Node.js 24 LTS; TypeScript 6.x strict ESM; exact patch versions locked by pnpm.

**Primary Dependencies**: MCP TypeScript SDK v2 packages `@modelcontextprotocol/server` and
`@modelcontextprotocol/hono`; Hono and `@hono/node-server`; Zod v4; `pg`; Pino; an RFC
8785-compatible JSON canonicalizer. `tsx` is a development dependency used only for local and CI
TypeScript commands.

**Tooling**: pnpm; type-aware ESLint flat configuration; Vitest projects; GitHub Actions; Docker and
Docker Compose.

**Storage**: One authoritative PostgreSQL database for accounts, API keys, repository usage, and
erasure audit. Catalog inventory, source content, provenance, advisory history, release batches, and
evaluation fixtures are version-controlled files. Repository-memory reads always reach PostgreSQL.

**Cache**: A bounded in-process verified catalog cache keyed by immutable release ID and revision
bundle hash. Repository memory, authentication state, and audit data are never cached.

**Testing**: Distinct Vitest projects for unit, contract, integration, end-to-end, evaluation, and
security responsibilities. Shared parameterized fixtures prevent the same failure matrix from being
reimplemented at multiple layers.

**Target Platform**: Linux OCI containers on Node.js 24 with one authoritative PostgreSQL database.
One or more identical stateless SkillWire instances may share that database; the local catalog cache
does not require invalidation because cached identities and content are immutable.

**Project Type**: Single-package backend service; one deployable modular monolith; no frontend and
no monorepo.

**Performance Evidence**: Reproducible informational measurements record environment, catalog
dataset/release, concurrency, cache state, sample count, failures, and raw/aggregate results. No
latency value changes acceptance or release status.

**Limits**: Request body at most 64 KiB; task at most 4 KiB UTF-8; instructions and each resource at
most 256 KiB; at most 64 resources and 2 MiB normalized content per revision; at most 10 previews
and 100 memory rows per response; 120 requests per minute per key with burst 30; repository hash is
exactly 64 lowercase hexadecimal characters.

**Excluded**: Caller-selected URLs, binary catalog resources, arbitrary execution, client writes,
sessions, repository-memory caches, Redis, queues, embeddings, crawlers, microservices, frontend,
database replicas, backup management, restore workflows, and physical-storage erasure.

## Constitution Check

*GATE: Passed before Phase 0 and re-evaluated after Phase 1.*

| Gate | Design evidence | Pre-design | Post-design |
|------|-----------------|------------|-------------|
| Remote delivery, never client installation | MCP responses are the only delivery path; end-to-end filesystem snapshots cover success, failure, retry, and verified-catalog-cache paths. | PASS | PASS |
| Retrieval, not execution | Only normalized Markdown and declared text are returned; production dependencies and adversarial tests prohibit execution, installers, hooks, and binaries. | PASS | PASS |
| Protocol portability | Six MCP tools call transport-neutral use cases; catalog administration is an offline maintainer CLI, not a harness adapter. | PASS | PASS |
| Immutable provenance | One create-only atomic launch batch hash-binds all published data; the verifier is structurally read-only and detects drift. | PASS | PASS |
| Private repository memory | Tenant-scoped PostgreSQL queries use only account plus opaque repository hash; no repository-memory cache or secondary authority exists. | PASS | PASS |
| Untrusted-content security | Strict schemas, safe paths, size limits, allowlisted sources, verified immutable caching, bearer auth, isolation, redaction, and safe failures are planned. | PASS | PASS |
| Test-backed contracts | MCP/CLI schemas, ranking, publication, advisories, persistence, erasure, audit expiry, isolation, resource safety, and no-install behavior have distinct automated suites. | PASS | PASS |
| Maintainable MVP | One package and modular service, one authoritative database, ten curated skills, two admin subcommands, and no excluded product or infrastructure scope. | PASS | PASS |

No constitution exception or complexity waiver is required.

## Project Structure

The following tree is exhaustive for this feature's persistent repository contents. It lists every
planned source, operational, fixture, test, catalog, Compose, workflow, and documentation file. A
new persistent planned file or directory requires a plan update. The publisher's fail-closed claim
directory and uniquely named sibling staging directory exist only during administration and are not
version-controlled tree entries.

### Feature documentation

```text
specs/001-remote-skill-delivery/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── catalog-inventory.md
├── security.md
├── testing-strategy.md
├── performance-benchmark.md
├── quickstart.md
├── deployment.md
├── tasks.md
├── checklists/
│   ├── requirements.md
│   ├── delivery-integrity.md
│   └── security.md
└── contracts/
    ├── mcp-tools.md
    ├── streamable-http.md
    ├── catalog-maintenance.md
    └── schemas/
        ├── common.schema.json
        ├── search_skills.input.schema.json
        ├── search_skills.output.schema.json
        ├── load_skill.input.schema.json
        ├── load_skill.output.schema.json
        ├── read_skill_resource.input.schema.json
        ├── read_skill_resource.output.schema.json
        ├── list_repo_memory.input.schema.json
        ├── list_repo_memory.output.schema.json
        ├── record_skill_outcome.input.schema.json
        ├── record_skill_outcome.output.schema.json
        ├── forget_repo_memory.input.schema.json
        ├── forget_repo_memory.output.schema.json
        ├── catalog-release.schema.json
        ├── catalog-publish.output.schema.json
        └── catalog-verify.output.schema.json
```

### Repository root

```text
.github/
└── workflows/
    └── ci.yml

benchmarks/
├── informational-benchmark.ts
├── operation-mix.v1.json
├── result.schema.json
└── results/
    └── .gitkeep

catalog/
├── inventory.json
├── advisories.jsonl
├── releases/
│   └── launch-catalog-v1/
│       ├── release.json
│       └── revisions/
│           ├── dependency-upgrade-planning.json
│           ├── dockerfile-hardening.json
│           ├── github-actions-ci.json
│           ├── node-api-design.json
│           ├── postgres-schema-review.json
│           ├── react-accessibility.json
│           ├── technical-documentation.json
│           ├── threat-modeling.json
│           ├── typescript-code-review.json
│           └── vitest-test-design.json
└── skills/
    ├── typescript-code-review/1.0.0/
    │   ├── SKILL.md
    │   ├── provenance.json
    │   └── references/review-checklist.md
    ├── react-accessibility/1.0.0/
    │   ├── SKILL.md
    │   ├── provenance.json
    │   └── references/accessibility-checklist.md
    ├── node-api-design/1.0.0/
    │   ├── SKILL.md
    │   ├── provenance.json
    │   └── references/api-review-checklist.md
    ├── postgres-schema-review/1.0.0/
    │   ├── SKILL.md
    │   ├── provenance.json
    │   └── references/schema-review-checklist.md
    ├── vitest-test-design/1.0.0/
    │   ├── SKILL.md
    │   ├── provenance.json
    │   └── references/test-design-checklist.md
    ├── threat-modeling/1.0.0/
    │   ├── SKILL.md
    │   ├── provenance.json
    │   └── references/threat-model-template.md
    ├── github-actions-ci/1.0.0/
    │   ├── SKILL.md
    │   ├── provenance.json
    │   └── references/ci-checklist.md
    ├── dockerfile-hardening/1.0.0/
    │   ├── SKILL.md
    │   ├── provenance.json
    │   └── references/hardening-checklist.md
    ├── technical-documentation/1.0.0/
    │   ├── SKILL.md
    │   ├── provenance.json
    │   └── references/documentation-checklist.md
    └── dependency-upgrade-planning/1.0.0/
        ├── SKILL.md
        ├── provenance.json
        └── references/upgrade-checklist.md

docs/
├── api-keys.md
├── catalog-publication.md
├── operations.md
└── privacy.md

evaluation/
├── search-ranking.v1.json
└── three-call-journeys.v1.json

migrations/
├── 001_accounts_and_api_keys.sql
├── 002_repository_skill_usage.sql
└── 003_repository_erasure_audit.sql

scripts/
└── smoke-mcp.ts

src/
├── domain/
│   ├── catalog/
│   │   ├── types.ts
│   │   ├── text-normalization.ts
│   │   ├── canonical-revision.ts
│   │   ├── revision-integrity.ts
│   │   ├── advisory-chain.ts
│   │   ├── ranking.ts
│   │   └── resource-path.ts
│   └── repository-memory/
│       ├── types.ts
│       └── outcome.ts
├── application/
│   ├── ports/
│   │   ├── skill-catalog-provider.ts
│   │   ├── repository-memory-store.ts
│   │   ├── erasure-audit-store.ts
│   │   ├── api-key-store.ts
│   │   └── clock.ts
│   ├── services/
│   │   ├── audit-expiration-service.ts
│   │   └── advisory-status-service.ts
│   └── use-cases/
│       ├── search-skills.ts
│       ├── load-skill.ts
│       ├── read-skill-resource.ts
│       ├── list-repo-memory.ts
│       ├── record-skill-outcome.ts
│       └── forget-repo-memory.ts
├── catalog/
│   ├── admin-cli.ts
│   ├── catalog-publisher.ts
│   ├── catalog-verifier.ts
│   ├── github-release-baseline.ts
│   ├── catalog-loader.ts
│   ├── version-controlled-provider.ts
│   └── verified-revision-cache.ts
├── evaluation/
│   ├── search-ranking-runner.ts
│   └── three-call-journey-runner.ts
├── transport/
│   └── mcp/
│       ├── app.ts
│       ├── server-factory.ts
│       ├── tool-adapters.ts
│       └── schemas.ts
├── authentication/
│   ├── admin-cli.ts
│   ├── api-key-authenticator.ts
│   ├── api-key-token.ts
│   └── middleware.ts
├── persistence/
│   └── postgres/
│       ├── client.ts
│       ├── migration-runner.ts
│       ├── api-key-store.ts
│       ├── repository-memory-store.ts
│       └── erasure-audit-store.ts
├── lifecycle/
│   ├── audit-cleanup-scheduler.ts
│   └── readiness-state.ts
├── observability/
│   ├── audit-events.ts
│   ├── logger.ts
│   ├── redaction.ts
│   └── request-context.ts
├── composition.ts
├── config.ts
└── main.ts

tests/
├── unit/
│   ├── domain/
│   │   ├── catalog-types.test.ts
│   │   ├── canonical-revision.test.ts
│   │   ├── advisory-chain.test.ts
│   │   ├── resource-path.test.ts
│   │   ├── ranking.test.ts
│   │   └── repository-memory.test.ts
│   ├── authentication/api-key.test.ts
│   ├── evaluation/fixture-validation.test.ts
│   └── observability/redaction.test.ts
├── contract/
│   ├── catalog-cli/
│   │   ├── catalog-publish.test.ts
│   │   └── catalog-verify.test.ts
│   ├── mcp/
│   │   ├── search-skills.test.ts
│   │   ├── load-skill.test.ts
│   │   ├── read-skill-resource.test.ts
│   │   ├── list-repo-memory.test.ts
│   │   ├── record-skill-outcome.test.ts
│   │   ├── forget-repo-memory.test.ts
│   │   └── streamable-http.test.ts
│   └── schemas/schema-drift.test.ts
├── evaluation/
│   ├── search-ranking.test.ts
│   └── three-call-journeys.test.ts
├── integration/
│   ├── postgres/
│   │   ├── migrations.test.ts
│   │   ├── api-keys.test.ts
│   │   ├── repository-memory-store.test.ts
│   │   ├── repository-erasure.test.ts
│   │   └── erasure-audit-expiration.test.ts
│   └── service/
│       ├── composition.test.ts
│       ├── memory-after-restart.test.ts
│       └── audit-cleanup-readiness.test.ts
├── e2e/
│   ├── search-skills.test.ts
│   ├── load-skill.test.ts
│   ├── read-skill-resource.test.ts
│   ├── repository-memory.test.ts
│   ├── outcomes-and-erasure.test.ts
│   └── no-client-write.test.ts
├── security/
│   ├── authentication/bearer-authentication.test.ts
│   ├── catalog/advisory-release-baseline.test.ts
│   ├── catalog/resource-safety.test.ts
│   ├── repository-memory/tenant-isolation.test.ts
│   └── transport/ssrf-and-execution-boundaries.test.ts
├── helpers/
│   ├── database.ts
│   ├── filesystem-snapshot.ts
│   ├── fixed-clock.ts
│   ├── github-api-stub.ts
│   └── mcp-client.ts
└── fixtures/
    ├── advisory-chain/
    │   ├── genesis-valid.jsonl
    │   ├── non-genesis-valid.jsonl
    │   ├── mutated.jsonl
    │   ├── deleted.jsonl
    │   ├── inserted.jsonl
    │   └── reordered.jsonl
    ├── catalog/
    │   ├── canonical-revision.json
    │   ├── corrupt-revision.json
    │   └── multi-resource-revision/
    │       ├── SKILL.md
    │       ├── provenance.json
    │       ├── expected-revision.json
    │       └── references/
    │           ├── first.md
    │           └── second.md
    ├── github-release/
    │   ├── published-releases.json
    │   ├── published-prerelease-latest.json
    │   ├── published-release-tie.json
    │   ├── paginated-releases-page-1.json
    │   ├── paginated-releases-page-2.json
    │   ├── malformed-releases.json
    │   ├── lightweight-tag-ref.json
    │   ├── annotated-tag-ref.json
    │   ├── annotated-tag-object.json
    │   ├── malformed-tag-object.json
    │   ├── previous-advisory-content.json
    │   └── no-published-releases.json
    ├── auth/api-keys.json
    ├── memory/scopes.json
    ├── time/audit-expiration.json
    └── client-tree/README.md

.dockerignore
Dockerfile
compose.yaml
compose.test.yaml
compose.benchmark.yaml
eslint.config.mjs
package.json
pnpm-lock.yaml
README.md
tsconfig.json
vitest.config.ts
```

**Structure decision**: Domain modules contain no MCP, Hono, PostgreSQL, filesystem-adapter, GitHub,
or logging imports. Application code depends on domain types and five ports. Catalog administration
and GitHub baseline retrieval are offline adapters under `src/catalog`; runtime MCP code cannot call
publication. `composition.ts` is initially a compile-safe scaffold and becomes the final composition
root only after every concrete dependency exists.

## Architecture and Dependency Rules

```text
MCP/Hono adapters -> application use cases -> domain + ports
                                           <- PostgreSQL/catalog adapters
admin CLI -> publisher OR verifier -> catalog domain
verifier -> GitHub release baseline reader (CI only)
main -> final composition -> lifecycle/readiness
```

- MCP adapters validate protocol inputs and translate use-case results; they never query PostgreSQL,
  inspect GitHub, or read catalog files directly.
- Every repository-memory operation calls the tenant-scoped PostgreSQL store. No repository-memory
  result, ranking projection, outcome, or erasure state is retained in an application cache.
- The verified catalog cache admits a revision only after complete bundle verification and keys it by
  immutable release ID, revision identity, and bundle hash. It has no mutable invalidation protocol.
- `catalog-publisher.ts` is the only production module with catalog write capability.
- `catalog-verifier.ts` and `github-release-baseline.ts` have read-only interfaces and import no
  PostgreSQL adapter. Runtime service composition imports neither publisher nor GitHub baseline code.
- Initial `composition.ts` work defines dependency slots and lifecycle boundaries only. Final wiring
  happens after providers, PostgreSQL stores, all six use cases, scheduler, readiness state, and MCP
  handlers exist.
- All edits to `package.json` are sequenced. Work that shares the manifest is never planned as
  parallel work.
- `catalog:publish` serializes publication with an atomically created, fail-closed catalog claim;
  this is catalog administration state, not a repository-memory lock or runtime dependency.

## Input and Evaluation Ordering

Implementation preserves this order:

1. Configure the package and strict toolchain, including `tsx` and the two catalog scripts.
2. Define and test catalog, provenance, advisory, release, and repository-memory domain types.
3. Create the exact ten-entry inventory.
4. Create all ten `SKILL.md` files and declared textual resources.
5. Establish immutable source metadata and published provenance for every revision.
6. Create independently reviewed canonical/hash fixtures, corrupt fixtures, and GitHub-release
   fixtures before implementing the logic evaluated by them.
7. Create the complete search corpus and three-call journey matrix before ranking or journey
   behavior is implemented.
8. Implement canonicalization, hashing, safe paths, advisory validation, and evaluation runners.
9. Implement atomic batch publication, strictly read-only verification, and GitHub release baseline
   validation; publish and verify the ten-skill genesis batch.
10. Implement the runtime provider, catalog cache, ranking, PostgreSQL stores, use cases, lifecycle,
    MCP adapters, and final composition.

Fixtures are reviewed product inputs, never generated from the implementation they score.

## Atomic Catalog Publication and Read-Only Verification

`src/catalog/admin-cli.ts` accepts exactly two subcommands:

- `publish`: validates inventory, all ten source bundles, provenance, canonical forms, resource
  hashes, advisory state, and release arguments. It atomically creates the exclusive
  `catalog/releases/.publish-claim` directory, then holds that claim while rescanning published
  revision identities, building and syncing ten records plus `release.json`, and performing one
  same-filesystem rename to the absent final `catalog/releases/<release-id>/` path. A failure before
  rename exposes no batch; an existing claim, final path, or revision identity rejects all ten
  results and is never overwritten. A stale claim fails closed and is not automatically reclaimed.
- `verify`: validates inventory, provenance, canonical bundles, resource hashes, all batch records,
  advisory links/head, and release metadata. It exposes no repair mode, imports no catalog writer or
  database adapter, and performs no filesystem or database write. A present publication claim makes
  verification invalid and is never removed. Its JSON output reports every revision and each
  release/advisory check.

Package scripts are fixed as:

```json
{
  "catalog:publish": "tsx src/catalog/admin-cli.ts publish",
  "catalog:verify": "tsx src/catalog/admin-cli.ts verify"
}
```

Command contract tests run the real CLI process. Publication tests cover atomic success,
per-revision results, input failure, duplicate revision rejection, existing release rejection,
existing/stale claims, two concurrent publishers with exactly one winner, and crash/failure before
visibility. They also preserve a truthful created result if only post-rename claim cleanup fails.
Verification tests snapshot the workspace, deny write APIs, supply no database service, and prove
identical filesystem and database state before and after success or failure.

## Advisory Release Baseline

Each published `release.json` contains `genesis`, `previousReleaseCommit`, and
`advisoryChainHead`. Genesis requires `genesis: true`, `previousReleaseCommit: null`, no earlier
published batch, an initial candidate advisory chain, and no non-draft GitHub release (including no
prerelease).

For every non-genesis CI verification:

1. Fully paginate `GET /repos/{owner}/{repo}/releases?per_page=100` using `GITHUB_TOKEN` with
   `contents: read`. Retain `draft: false` entries with valid `published_at`, including prereleases,
   and select the unique greatest publication timestamp; a tie or incomplete page fails closed.
2. Read the selected release's exact `tag_name`, resolve `refs/tags/<tag_name>`, and peel annotated
   tag objects until a
   commit is reached. Reject cycles, non-commit terminal objects, and any result other than exactly
   40 lowercase hexadecimal characters.
3. Require the resolved SHA to equal `previousReleaseCommit` in the proposed `release.json`.
4. Retrieve the global `catalog/advisories.jsonl` through the GitHub Contents API with
   `ref=<resolved-sha>`; never pass a branch or tag as the content reference. Candidate release
   metadata is verified locally and supplies `previousReleaseCommit`; no prior release-directory
   lookup is needed.
5. Require the current advisory sequence to have the retrieved chain as an unchanged byte prefix,
   then validate sequence numbers, previous hashes, event hashes, exact revision bindings, and the
   proposed chain head.

Missing credentials, repository access, pagination, an unambiguous selected release, exact tag,
commit, valid candidate metadata, or prior chain fails closed. No merge-base discovery, branch name,
local fallback, or optional previous reference exists. For genesis, the same fully paginated list
distinguishes empty published history from an unavailable API and must contain zero non-draft
releases, including prereleases. The local verifier also requires no earlier batch and an initial
candidate advisory chain.

## PostgreSQL Repository Memory and Erasure

The PostgreSQL store applies the authenticated `account_id` and opaque `repository_hash` predicate
inside every statement. Search ranking reads the bounded usage projection directly from the store;
load upserts usage directly; list reads directly; outcome replacement and forget are direct
transactions. No memory data survives outside PostgreSQL after a request.

`forget_repo_memory`:

1. authenticates the account and validates the repository hash;
2. starts one PostgreSQL transaction;
3. deletes every matching usage/outcome row;
4. inserts the six-field privacy-safe audit row using one database timestamp and
   `expires_at = created_at + interval '30 days'`;
5. commits and returns the constant `{ forgotten: true }` response.

Any database failure rolls back and returns a safe error. Empty scopes and retries produce the same
response and reveal no prior existence. Subsequent reads and restarts cannot recover the deleted
live rows. Operator-managed backup, WAL, snapshot, and physical-media behavior remains outside the
API guarantee.

Every application audit query includes `expires_at > database_now`; expired audit events are never
returned or used. Each service instance runs the same idempotent `expires_at <= database_now`
deletion before setting readiness true, then hourly. Concurrent cleanup is safe. While service and
database availability are continuous, the maximum post-expiration physical delay is one hour. If
either is unavailable, no physical-deletion bound is claimed; after recovery, startup cleanup must
succeed before readiness becomes true.

## Test Responsibilities

| Suite | Exclusive responsibility |
|-------|--------------------------|
| Unit | Pure domain behavior: construction, canonicalization, hashes, advisory folding, paths, ranking, outcomes, fixture validation, authentication primitives, and redaction. |
| Contract | Zod/JSON schemas plus observable MCP, HTTP, and `admin-cli` request/output/exit/write boundaries. No database behavior. |
| Integration | Real PostgreSQL migrations, tenant predicates, transactions, persistence, expiry queries, cleanup, readiness, and composed internal service behavior. |
| End-to-end | Complete authenticated MCP journeys through HTTP, restart behavior, and the no-client-write invariant. |
| Security | Adversarial authentication, cross-tenant access, advisory baseline tampering/unavailability, SSRF, path traversal, oversized/binary content, and execution attempts. |
| Evaluation | Deterministic scoring of the frozen search and journey fixtures only. |

Shared fixtures and helpers own repeated cases. A behavior is asserted at the lowest useful layer;
higher layers assert only integration or boundary properties added by that layer.

## Release Readiness and Informational Measurement

A releasable MVP requires User Stories 1–5, all six tools, both 90% evaluation thresholds, immutable
publication and advisory checks, PostgreSQL persistence/erasure, audit logical expiry and readiness,
tenant/security coverage, and no-client-write evidence. User Story 1 alone is the first vertical
slice, never the MVP release.

GitHub Actions runs formatting, type-aware lint, strict typecheck, unit, contract, integration,
end-to-end, evaluation, and security jobs. Catalog verification has `contents: read`, performs the
mandatory GitHub previous-release check, and fails closed. Required jobs never run catalog
publication.

CI validates informational benchmark fixture and result schemas only. The benchmark runner and
Compose profile are manually invoked engineering tools; no observed latency or throughput value
passes or fails CI, acceptance, or release readiness.

## Phase Outputs

- Phase 0 decisions and primary-source evidence: [research.md](./research.md)
- Phase 1 entities, tables, and state transitions: [data-model.md](./data-model.md)
- Exact launch inputs and atomic batch layout: [catalog-inventory.md](./catalog-inventory.md)
- MCP, HTTP, CLI, release, and schema contracts: [contracts/](./contracts/)
- Security and privacy decisions: [security.md](./security.md)
- Suite responsibilities and fixture strategy: [testing-strategy.md](./testing-strategy.md)
- Informational measurement method: [performance-benchmark.md](./performance-benchmark.md)
- Local validation guide: [quickstart.md](./quickstart.md)
- Container, CI, readiness, and operator boundaries: [deployment.md](./deployment.md)

All technical-context questions are resolved. Phase 1 introduces no post-design constitution
violation.
