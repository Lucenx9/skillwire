# Tasks: Remote Skill Delivery MVP

**Input**: Design documents from `specs/001-remote-skill-delivery/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `security.md`, `testing-strategy.md`, `catalog-inventory.md`, `quickstart.md`, `deployment.md`

**Tests**: Required by the specification. Unit tests own isolated domain behavior; contract tests own schemas and CLI/MCP boundaries; integration tests own PostgreSQL and composed-service behavior; end-to-end tests own complete MCP journeys and the no-client-write invariant; security tests own adversarial and isolation matrices; evaluation tests alone calculate corpus thresholds. Shared parameterized fixtures must be reused across layers.

**Organization**: Tasks are grouped by user story after shared setup and foundations. User Story 1 is the first vertical slice only; a releasable MVP requires User Stories 1–5 and the final readiness phase.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: May run in parallel after its stated prerequisites because it changes different files.
- **[Story]**: Maps the task to one user story from `spec.md`.
- Every task names the files it creates or changes.

---

## Phase 1: Setup

**Purpose**: Establish the single-package TypeScript service and its development commands.

- [ ] T001 Configure Node.js 24, TypeScript 6, pnpm, MCP SDK v2, Hono, Zod v4, PostgreSQL, Pino, Vitest, ESLint, `tsx`, all test scripts, `catalog:publish = tsx src/catalog/admin-cli.ts publish`, and `catalog:verify = tsx src/catalog/admin-cli.ts verify` in `package.json` and `pnpm-lock.yaml`
- [X] T002 Configure strict ESM compilation, type-aware flat ESLint, formatting checks, and distinct Vitest projects in `tsconfig.json`, `eslint.config.mjs`, and `vitest.config.ts`
- [ ] T003 Scaffold the exhaustive modular-monolith directories and compile-safe configuration/composition entrypoints without final dependency wiring in `src/config.ts`, `src/composition.ts`, and `src/main.ts`

**Checkpoint**: The empty service, lint, typecheck, and test-project configuration compile without pretending concrete adapters already exist.

---

## Phase 2: Foundational Inputs and Infrastructure

**Purpose**: Create immutable inputs first, then implement publication, authentication, transport, and shared runtime boundaries that block every user story.

**Critical ordering**: Catalog domain types precede providers, ranking, publication, and MCP handlers. Inventory precedes source/provenance content; frozen fixtures precede evaluated behavior; the complete launch batch is published and verified before runtime providers consume it.

- [ ] T004 Define `CatalogSkill`, `SkillRevision`, `ResourceManifestEntry`, `SourceReference`, `PublishedProvenance`, `RevisionAdvisory`, `SearchPreview`, release/result types, and repository-memory value types with isolated construction tests in `src/domain/catalog/types.ts`, `src/domain/repository-memory/types.ts`, `src/domain/repository-memory/outcome.ts`, `tests/unit/domain/catalog-types.test.ts`, and `tests/unit/domain/repository-memory.test.ts`
- [ ] T005 Create `catalog/inventory.json` first, then author the exact ten first-party `1.0.0` `SKILL.md`/`provenance.json` bundles and their declared resources at `catalog/skills/typescript-code-review/1.0.0/references/review-checklist.md`, `catalog/skills/react-accessibility/1.0.0/references/accessibility-checklist.md`, `catalog/skills/node-api-design/1.0.0/references/api-review-checklist.md`, `catalog/skills/postgres-schema-review/1.0.0/references/schema-review-checklist.md`, `catalog/skills/vitest-test-design/1.0.0/references/test-design-checklist.md`, `catalog/skills/threat-modeling/1.0.0/references/threat-model-template.md`, `catalog/skills/github-actions-ci/1.0.0/references/ci-checklist.md`, `catalog/skills/dockerfile-hardening/1.0.0/references/hardening-checklist.md`, `catalog/skills/technical-documentation/1.0.0/references/documentation-checklist.md`, and `catalog/skills/dependency-upgrade-planning/1.0.0/references/upgrade-checklist.md`
- [ ] T006 [P] Create independently reviewed canonical, corrupt, multi-resource, advisory-chain, GitHub release/tag/pagination, authentication, memory, time, and monitored-client fixtures in `tests/fixtures/catalog/`, `tests/fixtures/advisory-chain/`, `tests/fixtures/github-release/`, `tests/fixtures/auth/api-keys.json`, `tests/fixtures/memory/scopes.json`, `tests/fixtures/time/audit-expiration.json`, and `tests/fixtures/client-tree/README.md`
- [ ] T007 [P] Create and review at least 30 search cases with three per launch skill and at least 20 three-call journey cases, then reject malformed or incomplete corpora in `evaluation/search-ranking.v1.json`, `evaluation/three-call-journeys.v1.json`, and `tests/unit/evaluation/fixture-validation.test.ts`
- [ ] T008 Implement reusable database, filesystem snapshot, fixed-clock, GitHub API stub, and MCP client helpers that consume the shared fixtures in `tests/helpers/database.ts`, `tests/helpers/filesystem-snapshot.ts`, `tests/helpers/fixed-clock.ts`, `tests/helpers/github-api-stub.ts`, and `tests/helpers/mcp-client.ts`
- [ ] T009 Write golden tests first, then implement strict UTF-8 normalization, RFC 8785-compatible canonical bundles, resource/bundle SHA-256, safe resource paths, immutable release integrity, and advisory-chain folding in `tests/unit/domain/canonical-revision.test.ts`, `tests/unit/domain/advisory-chain.test.ts`, `tests/unit/domain/resource-path.test.ts`, `src/domain/catalog/text-normalization.ts`, `src/domain/catalog/canonical-revision.ts`, `src/domain/catalog/revision-integrity.ts`, `src/domain/catalog/resource-path.ts`, and `src/domain/catalog/advisory-chain.ts`
- [ ] T010 Write real-command contract tests for atomic create-only publication and strictly read-only verification, including ten per-skill results, duplicate/existing/stale claims, concurrent publishers, post-rename claim cleanup failure, one valid GitHub boundary, no repair, and zero verifier writes in `tests/contract/catalog-cli/catalog-publish.test.ts` and `tests/contract/catalog-cli/catalog-verify.test.ts`
- [ ] T011 Implement the `publish` subcommand with complete-batch validation, exclusive `.publish-claim`, protected duplicate rescan, synced staging, atomic rename, truthful ten-revision results, and no overwrite in `src/catalog/catalog-publisher.ts` and `src/catalog/admin-cli.ts`
- [ ] T012 Implement the strictly read-only `verify` subcommand and GitHub previous-release baseline with fully paginated `draft: false` selection by unique greatest `published_at`, exact tag peeling, immutable commit comparison, and advisory-prefix checks in `src/catalog/catalog-verifier.ts`, `src/catalog/github-release-baseline.ts`, and `src/catalog/admin-cli.ts`
- [ ] T013 Publish and verify the complete ten-skill genesis batch once, assert one structured result per skill, and produce one atomic release with ten independently traceable records in `catalog/releases/launch-catalog-v1/release.json`, `catalog/releases/launch-catalog-v1/revisions/*.json`, and `catalog/advisories.jsonl`
- [ ] T014 Implement the version-controlled catalog loader/provider, immutable verified-revision cache, and advisory-status service against the published batch in `src/application/ports/skill-catalog-provider.ts`, `src/application/services/advisory-status-service.ts`, `src/catalog/catalog-loader.ts`, `src/catalog/version-controlled-provider.ts`, and `src/catalog/verified-revision-cache.ts`
- [ ] T015 [P] Implement versioned migration execution, accounts/API-key persistence, non-recoverable bearer-key hashing/rotation/revocation, constant-time authentication, and the out-of-band key CLI with focused tests in `migrations/001_accounts_and_api_keys.sql`, `src/persistence/postgres/client.ts`, `src/persistence/postgres/migration-runner.ts`, `src/persistence/postgres/api-key-store.ts`, `src/application/ports/api-key-store.ts`, `src/authentication/api-key-token.ts`, `src/authentication/api-key-authenticator.ts`, `src/authentication/admin-cli.ts`, `tests/unit/authentication/api-key.test.ts`, `tests/integration/postgres/migrations.test.ts`, and `tests/integration/postgres/api-keys.test.ts`
- [ ] T016 [P] Implement bounded configuration, request/deadline context, allowlisted structured events, recursive secret/repository redaction, and logging tests in `src/config.ts`, `src/application/ports/clock.ts`, `src/observability/request-context.ts`, `src/observability/audit-events.ts`, `src/observability/redaction.ts`, `src/observability/logger.ts`, and `tests/unit/observability/redaction.test.ts`
- [ ] T017 Implement bearer/host/body/rate middleware and the stateless Hono/MCP server skeleton with strict six-tool Zod schemas, safe error translation, health endpoints, and HTTP/schema-drift contract tests in `src/authentication/middleware.ts`, `src/transport/mcp/schemas.ts`, `src/transport/mcp/server-factory.ts`, `src/transport/mcp/app.ts`, `tests/contract/mcp/streamable-http.test.ts`, and `tests/contract/schemas/schema-drift.test.ts`

**Checkpoint**: The exact catalog is atomically published and read-only verified; authentication and stateless transport foundations work; no runtime provider depends on unpublished content.

---

## Phase 3: User Story 1 — First Vertical Slice: Discover Relevant Skills (Priority: P1)

**Goal**: Return compact ranked previews for a natural-language task without instructions or resource bodies.

**Independent Test**: Run the frozen search corpus; at least 90% place the expected skill in the top three, all ten skills have three cases, both trust fields are present, and hash-free search writes no repository memory.

### Tests for User Story 1

- [X] T018 [P] [US1] Write preview-only MCP contract and representative authenticated HTTP journey tests without duplicating ranking matrices in `tests/contract/mcp/search-skills.test.ts` and `tests/e2e/search-skills.test.ts`
- [ ] T019 [P] [US1] Write deterministic top-three threshold enforcement over the single frozen corpus in `tests/evaluation/search-ranking.test.ts`

### Implementation for User Story 1

- [ ] T020 [US1] Implement deterministic lexical relevance, stable ties, bounded optional repository-outcome boost inputs, search evaluation scoring, and the search use case in `src/domain/catalog/ranking.ts`, `tests/unit/domain/ranking.test.ts`, `src/evaluation/search-ranking-runner.ts`, and `src/application/use-cases/search-skills.ts`
- [X] T021 [US1] Wire `search_skills` through strict schemas and adapters, returning `SearchPreview` with `trustAtPublication` and `currentAdvisoryStatus` only, in `src/transport/mcp/schemas.ts` and `src/transport/mcp/tool-adapters.ts`

**Checkpoint**: User Story 1 is independently demonstrable as the first vertical slice, but it is not a releasable MVP.

---

## Phase 4: User Story 2 — Load a Verifiable Skill Revision (Priority: P2)

**Goal**: Load one exact immutable revision with instructions, complete provenance, bundle hash, advisory status, and manifest while never executing or installing content.

**Independent Test**: Repeatedly load an exact revision, verify byte-identical provenance/content and the complete bundle, exercise valid/corrupt cache fallback, reject unknown revisions, and prove the monitored client tree is unchanged.

### Tests for User Story 2

- [ ] T022 [P] [US2] Write the exact-revision MCP contract tests for provenance, trust fields, manifests, immutable repeat loads, unavailable revisions, and cache integrity in `tests/contract/mcp/load-skill.test.ts`
- [ ] T023 [P] [US2] Write load/no-client-write end-to-end cases and the advisory release-baseline adversarial matrix using shared fixtures in `tests/e2e/load-skill.test.ts`, `tests/e2e/no-client-write.test.ts`, and `tests/security/catalog/advisory-release-baseline.test.ts`

### Implementation for User Story 2

- [ ] T024 [US2] Implement exact-version resolution, complete bundle verification, immutable-cache fallback re-verification, advisory availability/revocation behavior, and inert-text responses in `src/application/use-cases/load-skill.ts`, `src/catalog/version-controlled-provider.ts`, and `src/catalog/verified-revision-cache.ts`
- [ ] T025 [US2] Wire `load_skill` through strict MCP schemas/adapters with full immutable provenance and no resource bodies in `src/transport/mcp/schemas.ts` and `src/transport/mcp/tool-adapters.ts`

**Checkpoint**: Exact immutable revisions load reproducibly and never write to or execute on the client.

---

## Phase 5: User Story 3 — Read Resources Progressively (Priority: P3)

**Goal**: Return one validated declared textual resource only when requested.

**Independent Test**: Load a multi-resource revision, retrieve one declared resource, reject unsafe/undeclared/binary/oversized/caller-URL cases, and meet the frozen 90% three-call journey threshold.

### Tests for User Story 3

- [ ] T026 [P] [US3] Write the resource MCP boundary contract, including rejection of caller URL fields, and the single shared adversarial path/text/size matrix in `tests/contract/mcp/read-skill-resource.test.ts` and `tests/security/catalog/resource-safety.test.ts`
- [ ] T027 [P] [US3] Write one representative progressive HTTP journey plus deterministic call-budget threshold enforcement over the frozen matrix in `tests/e2e/read-skill-resource.test.ts` and `tests/evaluation/three-call-journeys.test.ts`

### Implementation for User Story 3

- [ ] T028 [US3] Implement exact-revision declared-resource lookup, containment-safe regular-file reads, UTF-8/media/size validation, and per-resource hash verification in `src/application/use-cases/read-skill-resource.ts`, `src/catalog/catalog-loader.ts`, and `src/catalog/version-controlled-provider.ts`
- [ ] T029 [US3] Wire `read_skill_resource` through strict MCP schemas/adapters and return only the selected resource in `src/transport/mcp/schemas.ts` and `src/transport/mcp/tool-adapters.ts`
- [ ] T030 [US3] Implement deterministic one-search/one-load/optional-one-resource journey execution and recorded operation counts in `src/evaluation/three-call-journey-runner.ts`

**Checkpoint**: Progressive loading is complete and the frozen journey matrix meets its threshold without duplicated evaluation cases.

---

## Phase 6: User Story 4 — Recall Repository Skill Usage (Priority: P4)

**Goal**: Persist exact loaded revisions under authenticated account plus opaque repository hash and list them after restart without caching repository memory.

**Independent Test**: Load with repository hash A, restart, list A, and prove repository B, another account, and hash-free loads cannot observe that record.

### Tests for User Story 4

- [ ] T031 [P] [US4] Write `list_repo_memory` MCP contracts and the complete load/list/restart journey without duplicating tenant attack cases in `tests/contract/mcp/list-repo-memory.test.ts` and `tests/e2e/repository-memory.test.ts`
- [ ] T032 [P] [US4] Write direct-PostgreSQL persistence, restart, account/hash isolation, and no-repository-cache integration/security cases using the shared scope matrix in `tests/integration/postgres/repository-memory-store.test.ts`, `tests/integration/service/memory-after-restart.test.ts`, and `tests/security/repository-memory/tenant-isolation.test.ts`

### Implementation for User Story 4

- [ ] T033 [US4] Add the tenant-first usage table and direct PostgreSQL repository-memory port/store with bounded list and idempotent exact-revision upsert in `migrations/002_repository_skill_usage.sql`, `src/application/ports/repository-memory-store.ts`, and `src/persistence/postgres/repository-memory-store.ts`
- [ ] T034 [US4] Integrate optional repository context into load recording and direct-database search boost projection while preserving zero persistence for hash-free calls in `src/application/use-cases/load-skill.ts`, `src/application/use-cases/search-skills.ts`, and `src/domain/catalog/ranking.ts`
- [ ] T035 [US4] Implement and wire `list_repo_memory` with strict account/hash scoping and constant empty-scope behavior in `src/application/use-cases/list-repo-memory.ts`, `src/transport/mcp/schemas.ts`, and `src/transport/mcp/tool-adapters.ts`

**Checkpoint**: Repository memory is durable, inspectable, tenant-isolated, and queried directly from PostgreSQL with no repository-memory cache.

---

## Phase 7: User Story 5 — Record Outcomes and Erase Memory (Priority: P5)

**Goal**: Replace bounded outcomes and synchronously erase one tenant/repository memory scope with privacy-safe expiring audit evidence.

**Independent Test**: Record all three outcomes for a seeded load, erase the scope, verify transactional absence before success and after restart, prove idempotent existence-hiding behavior, and validate unconditional logical audit expiry plus availability-qualified cleanup/readiness.

### Tests for User Story 5

- [ ] T036 [P] [US5] Write MCP contracts and complete outcome/erasure journeys for supported replacement, missing usage, idempotent forget, and constant success shape in `tests/contract/mcp/record-skill-outcome.test.ts`, `tests/contract/mcp/forget-repo-memory.test.ts`, and `tests/e2e/outcomes-and-erasure.test.ts`
- [ ] T037 [P] [US5] Write transactional erasure, rollback, six-field audit, exact expiry, filtered reads, hourly cleanup, downtime/readiness, and outcome/forget isolation tests in `tests/integration/postgres/repository-erasure.test.ts`, `tests/integration/postgres/erasure-audit-expiration.test.ts`, `tests/integration/service/audit-cleanup-readiness.test.ts`, and `tests/security/repository-memory/tenant-isolation.test.ts`

### Implementation for User Story 5

- [ ] T038 [US5] Add the six-field erasure-audit table and implement filtered reads, direct transactional deletion support, startup/hourly cleanup, and readiness state in `migrations/003_repository_erasure_audit.sql`, `src/application/ports/erasure-audit-store.ts`, `src/persistence/postgres/erasure-audit-store.ts`, `src/application/services/audit-expiration-service.ts`, `src/lifecycle/audit-cleanup-scheduler.ts`, and `src/lifecycle/readiness-state.ts`
- [ ] T039 [US5] Implement outcome replacement for an existing tenant-scoped usage and wire `record_skill_outcome` in `src/application/use-cases/record-skill-outcome.ts`, `src/transport/mcp/schemas.ts`, and `src/transport/mcp/tool-adapters.ts`
- [ ] T040 [US5] Implement the single PostgreSQL delete-plus-audit transaction and wire constant-shape `forget_repo_memory` without any cache invalidation path in `src/application/use-cases/forget-repo-memory.ts`, `src/persistence/postgres/repository-memory-store.ts`, `src/transport/mcp/schemas.ts`, and `src/transport/mcp/tool-adapters.ts`
- [ ] T041 [US5] Complete final dependency composition only after all concrete providers, stores, use cases, schedulers, readiness state, and six MCP handlers exist, then verify composed startup/restart behavior in `src/composition.ts`, `src/main.ts`, and `tests/integration/service/composition.test.ts`

**Checkpoint**: All five user stories and all six MCP operations are implemented; repository erasure and audit retention satisfy the live-database boundary.

---

## Phase 8: Release Readiness and Informational Measurement

**Purpose**: Complete cross-cutting security, delivery, operations, CI, and nonblocking measurement evidence required for a releasable MVP.

- [ ] T042 Complete the transport-level SSRF/arbitrary-URL, hostile Host, authentication ambiguity, rate/size/deadline, untrusted-code execution, and forbidden-capability matrix and apply resulting hardening in `tests/security/authentication/bearer-authentication.test.ts`, `tests/security/transport/ssrf-and-execution-boundaries.test.ts`, `src/authentication/middleware.ts`, `src/transport/mcp/app.ts`, and `src/transport/mcp/tool-adapters.ts`
- [ ] T043 [P] Configure pinned GitHub Actions jobs for formatting, type-aware lint, typecheck, unit, contract, evaluation, PostgreSQL integration, end-to-end, security, Docker/Compose, and read-only `catalog:verify` with `contents: read` in `.github/workflows/ci.yml`
- [ ] T044 [P] Build the unprivileged read-only Node.js 24 image and authoritative-PostgreSQL development/test/benchmark environments without replicas, Redis, queues, or backup services in `Dockerfile`, `.dockerignore`, `compose.yaml`, `compose.test.yaml`, and `compose.benchmark.yaml`
- [ ] T045 [P] Document API-key lifecycle, atomic catalog administration/claim recovery, direct-PostgreSQL privacy and erasure boundaries, readiness/cleanup operations, and MCP usage in `README.md`, `docs/api-keys.md`, `docs/catalog-publication.md`, `docs/privacy.md`, and `docs/operations.md`
- [ ] T046 [P] Implement the versioned informational workload, result schema, raw-result hashing, and cold/warm immutable-catalog measurements with no timing gate in `benchmarks/operation-mix.v1.json`, `benchmarks/result.schema.json`, `benchmarks/informational-benchmark.ts`, and `benchmarks/results/.gitkeep`
- [ ] T047 Run the complete release-readiness sequence without adding duplicate matrices and make the authenticated progressive smoke journey pass without client writes in `scripts/smoke-mcp.ts`, `tests/e2e/no-client-write.test.ts`, and all test projects configured by `vitest.config.ts`

**Checkpoint**: The releasable MVP includes User Stories 1–5, all six tools, both 90% evaluation thresholds, security/privacy evidence, immutable catalog administration, readiness cleanup, no-client-write evidence, and nonblocking performance measurements.

---

## Dependencies and Execution Order

### Phase Dependencies

- **Setup (Phase 1)** starts immediately; T001 precedes T002, and T003 follows the configured toolchain.
- **Foundational (Phase 2)** depends on Setup and blocks all user stories. T004 → T005 → T006/T007 → T008/T009 → T010 → T011 → T012 → T013 → T014 preserves the catalog input/publication/provider order. T015 and T016 may proceed independently after Setup; T017 requires T015 and T016.
- **User Story 1 (Phase 3)** depends on the complete foundation and delivers only the first vertical slice.
- **User Story 2 (Phase 4)** depends on the complete foundation and may be implemented in parallel with User Story 1 when staffed separately.
- **User Story 3 (Phase 5)** depends on User Stories 1 and 2 for the measured progressive journey.
- **User Story 4 (Phase 6)** depends on User Stories 1 and 2 because it adds persistence to load and repository-aware ranking to search.
- **User Story 5 (Phase 7)** depends on User Story 4's authoritative usage store.
- **Release Readiness (Phase 8)** depends on all five stories; T043–T046 may proceed in parallel, and T047 is last.

### Within Each User Story

- Frozen shared fixtures already exist before story tests.
- Story tests are written before the behavior they specify.
- Pure/domain logic precedes use cases; use cases precede MCP adapter wiring.
- Each layer asserts only its assigned responsibility; shared matrices are parameterized rather than copied.
- A story checkpoint must pass before its dependent story begins.

### Parallel Opportunities

- T006 and T007 can run together after T005; T015 and T016 can run alongside catalog foundation work after Setup.
- T018 and T019 can run together for User Story 1.
- T022 and T023 can run together for User Story 2.
- T026 and T027 can run together for User Story 3.
- T031 and T032 can run together for User Story 4.
- T036 and T037 can run together for User Story 5.
- T043, T044, T045, and T046 can run together after all stories.
- Only T001 changes `package.json`; no package-manifest task is marked parallel.

---

## Parallel Examples by User Story

```text
US1: T018 search boundary/journey tests || T019 search evaluation threshold test
US2: T022 load contract tests || T023 load/no-write/advisory security tests
US3: T026 resource contract/security tests || T027 journey/evaluation tests
US4: T031 list/load-memory boundary tests || T032 PostgreSQL/isolation/restart tests
US5: T036 outcome/forget boundary tests || T037 erasure/audit/readiness tests
```

---

## Implementation Strategy

### First Vertical Slice

1. Complete Setup and Foundational phases.
2. Complete User Story 1.
3. Run the independent search corpus and preview-only acceptance checks.
4. Report this only as the first vertical slice; do not release it as the MVP.

### Releasable MVP

1. Complete User Stories 1 and 2, which may proceed in parallel after the foundation.
2. Complete User Story 3 and its three-call threshold.
3. Complete User Story 4 with direct PostgreSQL repository memory.
4. Complete User Story 5 with outcomes, erasure, audit expiration, and readiness.
5. Complete Release Readiness and Informational Measurement.
6. Release only after all required jobs, thresholds, and security/privacy checks pass.

## Scope Guardrails

- Do not add repository-memory caching, cache invalidation, replicas, backup/WAL management, restore workflows, deletion journals, Redis, queues, microservices, embeddings, crawlers, a frontend, marketplace features, local skill installation, or arbitrary code execution.
- The only permitted cache is the verified immutable catalog cache in `src/catalog/verified-revision-cache.ts`.
- Performance measurements are informational and never block release based on timing.
