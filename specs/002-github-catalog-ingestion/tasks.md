---

description: "Dependency-ordered implementation tasks for GitHub catalog ingestion"
---

# Tasks: GitHub Catalog Ingestion

**Input**: Design documents from `specs/002-github-catalog-ingestion/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `security.md`,
`ingestion-state-machine.md`, `testing-strategy.md`, `migration-plan.md`,
`operational-synchronization.md`, and `quickstart.md`

**Tests**: Required. Create deterministic fixtures and failing tests before the implementations they
exercise. Required CI must never depend on live GitHub.

**Organization**: Three runnable vertical slices. Story labels retain traceability to the five user
stories in `spec.md`: Slice 1 is US2; Slice 2 combines US1, US4, and US5; Slice 3 is US3.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel after the stated prerequisite because it changes different files.
- **[US1]**: Discover public skill repositories.
- **[US2]**: Register and import one repository atomically.
- **[US3]**: Use imported skills remotely.
- **[US4]**: Synchronize without rewriting history.
- **[US5]**: Review, verify, quarantine, and curate imports.

## Phase 1: Setup

**Purpose**: Add only the parsing/tooling surface required by Feature 002 and preserve the existing
Node.js 24/TypeScript 6 modular monolith.

- [X] T001 Add pinned `yaml` and `mdast-util-from-markdown` dependencies without changing existing scripts in `package.json` and `pnpm-lock.yaml`

---

## Phase 2: Foundational Domain and Boundaries

**Purpose**: Define shared types, canonical integrity, ports, and Feature 001 compatibility before any
new persistence or use case.

**Critical**: Complete this phase before all vertical slices. Canonical v1 and existing catalog
publisher/verifier behavior must remain byte-for-byte compatible.

- [X] T002 Define validated GitHub identities, budgets, source/snapshot/candidate states, imported provenance, invocation modes, findings, dependencies, and advisory types in `src/domain/external-catalog/types.ts`
- [X] T003 Implement canonical external revision schema v2, separate content-identity and complete-bundle SHA-256 serialization, and v1-preservation tests in `src/domain/external-catalog/canonical-revision-v2.ts` and `tests/unit/external-catalog/canonical-revision-v2.test.ts`
- [X] T004 [P] Define cancellation-aware source, external catalog, and fenced lease ports without URLs or transport types in `src/application/ports/github-source-provider.ts`, `src/application/ports/external-catalog-store.ts`, and `src/application/ports/sync-lease-store.ts`
- [X] T005 Add architecture and regression assertions that Feature 001 canonical fixtures, six-tool inventory, `catalog:verify`, publisher module isolation, and all existing payloads remain unchanged in `tests/unit/domain/canonical-revision.test.ts`, `tests/contract/catalog-cli/catalog-verify.test.ts`, and `tests/contract/schemas/schema-drift.test.ts`

**Checkpoint**: External types and integrity contracts exist; Feature 001 regression tests still pass.

---

## Phase 3: Vertical Slice 1 — Registered Source Ingestion (Priority: P1) 🎯 MVP

**Mapped story**: US2 — Register and import a repository once.

**Goal**: An administrator registers `owner/repository`, resolves an exact public GitHub commit,
imports one authoritative Claude plugin manifest as an atomic immutable PostgreSQL batch, and lists
the traceable result without any agent-facing integration yet.

**Independent Test**: Using recorded REST fixtures only, run `source:add`, `source:sync`, and
`source:list` for `mattpocock/skills`; assert exact commit
`84fdeffd12f2ee307994d1eb6feb48173b6e0502`, manifest version 1.2.3, one atomic snapshot, MIT/Matt
Pocock provenance, and 25 per-skill results with exact paths/hashes and no duplicate or partial
revision. Run all Feature 001 tests unchanged.

### Fixtures and Failing Tests

- [X] T006 [US2] Record and checksum the fixed official-host repository/ref/commit/tree/manifest/license/25-skill/resource responses plus an independently reviewed 25-entry expected inventory in `tests/fixtures/github-ingestion/mattpocock-skills-84fdeffd12f2ee307994d1eb6feb48173b6e0502/routes.json`, `expected-inventory.json`, and `responses/`
- [X] T007 [P] [US2] Write failing additive migration, checksum, immutable-table, and Feature 001 upgrade compatibility tests in `tests/integration/postgres/github-ingestion-migrations.test.ts`
- [X] T008 [P] [US2] Build the no-network route-manifest fixture harness and failing fixed-origin, header, redirect, deadline, streamed-byte, exact commit/tree/blob, mode, path, and SHA tests in `tests/helpers/github-ingestion-fixture.ts`, `tests/unit/ingestion/github-rest-client.test.ts`, and `tests/unit/ingestion/github-object-reader.test.ts`
- [X] T009 [P] [US2] Write failing authoritative plugin-manifest, strict frontmatter, invocation metadata, safe Markdown-resource, UTF-8, traversal, binary, and size-limit tests against the recorded skills in `tests/unit/ingestion/import-parsers.test.ts`
- [X] T010 [P] [US2] Write failing `source:add`, `source:list`, `source:sync`, atomic rollback, overwrite rejection, idempotence, and 25-result traceability tests in `tests/contract/source-cli/registered-source.test.ts` and `tests/integration/github-ingestion/registered-source-ingestion.test.ts`

### Implementation

- [X] T011 [US2] Add backward-compatible source/job and immutable external snapshot/content/revision/resource migrations with exact SHA/path constraints and create-only triggers in `migrations/004_github_sources_and_jobs.sql` and `migrations/005_external_catalog_revisions.sql`
- [X] T012 [US2] Implement the native-fetch fixed-origin GitHub REST client and exact public repository → default ref → commit → complete tree → selected blob reader with validated one-hop rename handling and no content-derived requests in `src/ingestion/github/rest-client.ts` and `src/ingestion/github/commit-tree-blob-reader.ts`
- [X] T013 [P] [US2] Implement the authoritative `.claude-plugin/plugin.json` adapter, constrained YAML frontmatter parser, MDAST textual-resource parser, safe tree-relative resolver, and inert-text validation in `src/ingestion/parsing/claude-plugin-manifest.ts`, `src/ingestion/parsing/frontmatter.ts`, and `src/ingestion/parsing/markdown-resources.ts`
- [X] T014 [US2] Implement source/snapshot/content stores and create-only canonical v2 batch publication with hash-collision checks, rollback, deduplication, and per-skill observations in `src/persistence/postgres/github-source-store.ts`, `src/persistence/postgres/external-catalog-store.ts`, and `src/ingestion/external-revision-publisher.ts`
- [X] T015 [US2] Implement register/list/one-shot exact synchronization services and strict JSON administrator commands without URL/ref/skill arguments in `src/application/services/source-registration-service.ts`, `src/application/services/source-synchronization-service.ts`, `src/ingestion/admin-cli.ts`, and `package.json`
- [X] T016 [US2] Make the recorded 25-skill atomic import and all Slice 1/Feature 001 gates pass, including exact MIT/Matt Pocock provenance, failure injection, and zero clone/checkout/exec/filesystem materialization assertions in `tests/integration/github-ingestion/registered-source-ingestion.test.ts` and `tests/security/transport/ssrf-and-execution-boundaries.test.ts`

**Checkpoint**: Registered-source ingestion is runnable and independently verifiable; no discovery
scheduler or agent-visible imported catalog exists yet.

---

## Phase 4: Vertical Slice 2 — Automatic Discovery and Synchronization (Priorities: P1–P3)

**Mapped stories**: US1 discovery, US4 immutable synchronization, and US5 policy/curation.

**Goal**: Discover public candidates asynchronously, coordinate scheduled jobs with PostgreSQL
leases, validate both recognized layouts, classify deterministically, synchronize/deduplicate new
commits, and preserve immutable history and removal advisories.

**Independent Test**: Replay bounded duplicate discovery results and two exact repository commits
through two service instances. Verify one canonical source, fenced jobs, discovered invisibility,
verified/quarantined/curated transitions, nested fallback, license/dependency findings, changed/new/
reused/deleted outcomes, no late writes after cancellation, and old revisions unchanged/loadable
from PostgreSQL unless revoked.

### Fixtures and Failing Tests

- [ ] T017 [US1] Create deterministic discovery pages plus rename, ETag/304, rate-limit, retry, cancellation, nested-layout, license conflict, dependency, second-commit, removal, incomplete-tree, and source-unavailability mutation fixtures before their implementations in `tests/fixtures/github-ingestion/discovery/` and `tests/fixtures/github-ingestion/mutations/`
- [ ] T018 [P] [US1] Write failing discovery query/pagination/result/rate/byte budget, duplicate canonical repository, incomplete result, discovered-default-deny, and no-search-trigger tests in `tests/unit/ingestion/github-discovery-provider.test.ts` and `tests/integration/github-ingestion/discovery.test.ts`
- [ ] T019 [P] [US5] Write failing policy migration, nested `SKILL.md`, SPDX license/attribution, exact same-source dependency, stable finding, classification transition, quarantine, verify, and curation tests in `tests/integration/postgres/external-policy-migration.test.ts`, `tests/unit/external-catalog/candidate-policy.test.ts`, `tests/unit/external-catalog/license-validator.test.ts`, and `tests/unit/external-catalog/dependency-resolver.test.ts`
- [ ] T020 [P] [US4] Write failing two-instance lease/fencing, ETag cache binding, bounded retry, cancellation, rename alias, unchanged reuse, changed publication, deletion advisory, source-unavailability confirmation, and restart tests in `tests/integration/postgres/github-job-leases.test.ts` and `tests/integration/github-ingestion/synchronization.test.ts`
- [ ] T021 [P] [US5] Write failing strict `discover`, `verify`, `quarantine`, `curate`, and filtered `source:list` CLI contracts, authorization, idempotence, and no-write `catalog:verify` isolation tests in `tests/contract/source-cli/source-policy.test.ts` and `tests/contract/catalog-cli/catalog-verify.test.ts`
- [ ] T022 [P] [US4] Write failing SSRF/redirect/Link attacks, unsupported Git objects, parser bombs, traversal, binary/oversize, hash replacement, lease races, deadline rollback, log redaction, and no-execution tests in `tests/security/github-ingestion/acquisition-boundaries.test.ts` and `tests/security/github-ingestion/cancellation-and-redaction.test.ts`

### Implementation

- [ ] T023 [US5] Add verification reports/findings, append-only classification/curation history, current projections, and serialized external advisory-chain migration with immutable triggers in `migrations/006_external_policy_and_advisories.sql`
- [ ] T024 [US1] Implement server-controlled GitHub search discovery, deterministic pagination, conditional metadata cache, shared budget ledger, and discovery evidence persistence in `src/ingestion/github/discovery-provider.ts`, `src/application/services/source-discovery-service.ts`, and `src/persistence/postgres/github-source-store.ts`
- [ ] T025 [P] [US4] Implement persistent PostgreSQL lease acquisition/renewal/release, monotonic fencing checks, due-job claims, and shutdown-aware scheduled discovery/synchronization in `src/persistence/postgres/sync-lease-store.ts` and `src/lifecycle/github-sync-scheduler.ts`
- [ ] T026 [US5] Implement bounded nested `SKILL.md` fallback, pinned SPDX license/notice/attribution validation, exact same-snapshot dependency resolution/evidence, stable findings, candidate policy, and legal classification transitions in `src/ingestion/parsing/nested-skill-layout.ts`, `src/domain/external-catalog/license-validator.ts`, `src/domain/external-catalog/dependency-resolver.ts`, and `src/domain/external-catalog/candidate-policy.ts`
- [ ] T027 [US4] Extend synchronization with ETags, bounded retry/rate reset, whole-run cancellation, validated rename aliases, content/revision/resource deduplication, equality observations, atomic source-head moves, update/removal advisories, and fail-closed partial acquisition in `src/application/services/source-synchronization-service.ts` and `src/persistence/postgres/external-catalog-store.ts`
- [ ] T028 [US5] Add administrator discovery/verification/quarantine/curation/list orchestration and safe structured results/reason codes while preserving immutable publication facts in `src/ingestion/admin-cli.ts` and `src/application/services/source-registration-service.ts`
- [ ] T029 [US4] Make all Slice 2 state-machine, operational synchronization, persistence/restart, adversarial acquisition, redaction, cancellation, and Feature 001 regression suites pass via `tests/integration/github-ingestion/synchronization.test.ts` and `tests/security/github-ingestion/`

**Checkpoint**: Automatic discovery and scheduled synchronization are runnable; only structurally
verified or curated immutable imports can become eligible, but imported skills are not yet merged
into MCP search/load/resource.

---

## Phase 5: Vertical Slice 3 — Unified Agent Discovery (Priority: P1)

**Mapped story**: US3 — Use imported skills remotely.

**Goal**: Merge eligible imported revisions with Feature 001, preserve deterministic relevance and
repository-memory behavior, expose invocation context and external provenance, and complete remote
search → exact load → resource with no client installation.

**Independent Test**: With the atomic 25-skill acceptance snapshot published, complete
`search_skills(invocationContext: user-requested)` → `load_skill(exact revision)` →
`read_skill_resource(PHASE-BOUNDARIES.md)` in three calls. Verify preview-only search, exact immutable
provenance/license/dependencies, automatic exclusion of all 14 user-only skills, current advisory/
classification behavior, unchanged repository-memory ranking, zero GitHub calls, and a byte-identical
client tree.

### Fixtures and Failing Tests

- [ ] T030 [US3] Create immutable imported-search and journey evaluation datasets covering all 25 acceptance skills, at least 40 ranking cases, at least 25 call-budget journeys, 14 user-only modes, exact dependencies/resources, forbidden states, and 90% thresholds in `evaluation/github-import-search.v1.json` and `evaluation/github-import-journeys.v1.json`
- [ ] T031 [P] [US3] Write failing backward-compatible MCP schema/tool-inventory contracts for optional `invocationContext`, discriminated external previews/load metadata, exact dependency entries, preview-only search, and unchanged resource/memory schemas in `tests/contract/mcp/search-skills.test.ts`, `tests/contract/mcp/load-skill.test.ts`, `tests/contract/mcp/read-skill-resource.test.ts`, and `tests/contract/schemas/schema-drift.test.ts`
- [ ] T032 [P] [US3] Write failing PostgreSQL provider, unified deterministic ranking, positive-relevance-before-memory, unavailable/revoked, restart, three-call, no-GitHub, account isolation, erasure, and client-tree invariance tests in `tests/integration/service/imported-catalog-provider.test.ts`, `tests/e2e/github-ingestion.test.ts`, and `tests/e2e/no-client-write.test.ts`

### Implementation

- [ ] T033 [US3] Add an asynchronous cancellation-aware catalog port, wrap the unchanged first-party provider, implement direct verified PostgreSQL imported reads, and merge them deterministically in `src/application/ports/async-skill-catalog-provider.ts`, `src/catalog/static-provider-adapter.ts`, `src/persistence/postgres/external-catalog-provider.ts`, and `src/catalog/unified-provider.ts`
- [ ] T034 [US3] Extend strict search schemas/use case/adapters with optional `invocationContext` defaulting to automatic, external-only discriminated previews, classification/advisory/invocation filtering before ranking, and memory boosts only after positive relevance in `src/transport/mcp/schemas.ts`, `src/application/use-cases/search-skills.ts`, and `src/transport/mcp/tool-adapters.ts`
- [ ] T035 [US3] Extend exact load/resource use cases with canonical v2 re-verification, external provenance/license/invocation/dependencies, manifest-only load, single-resource bodies, unavailable verified reads, revoked denial, and transactional memory recording in `src/application/use-cases/load-skill.ts`, `src/application/use-cases/read-skill-resource.ts`, and `src/transport/mcp/tool-adapters.ts`
- [ ] T036 [US3] Compose the unified provider and scheduler with strict live-ingestion configuration, PostgreSQL/readiness probes, clean shutdown, and no GitHub readiness dependency in `src/config.ts`, `src/composition.ts`, `src/main.ts`, and `src/lifecycle/readiness-state.ts`
- [ ] T037 [US3] Implement imported evaluation loaders/threshold enforcement and make all 25 traceable acceptance outcomes, repository-memory cases, and three-call journeys pass in `src/evaluation/`, `tests/evaluation/github-import-search.test.ts`, and `tests/evaluation/github-import-journeys.test.ts`
- [ ] T038 [P] [US3] Update production/container configuration, required recorded-fixture CI, source administration/operations/security documentation, and quickstart commands in `Dockerfile`, `compose.yaml`, `compose.test.yaml`, `.github/workflows/ci.yml`, `README.md`, `docs/operations.md`, and `specs/002-github-catalog-ingestion/quickstart.md`
- [ ] T039 [P] [US3] Implement the optional token-gated fixed-commit live GitHub smoke command with no fixture rewrite or required-CI dependency in `scripts/smoke-github-live.ts`, `package.json`, and `.github/workflows/github-live-smoke.yml`
- [ ] T040 [US3] Make the complete Slice 3 MCP contracts, 25-skill acceptance/evaluation, operational synchronization, repository-memory isolation, container restart/readiness/shutdown, and no-client-install journey pass through `tests/e2e/github-ingestion.test.ts` and `tests/evaluation/`

**Checkpoint**: Feature 002 is complete and remotely usable; all existing Feature 001 contracts and
tests remain compatible.

---

## Phase 6: Final Cross-Cutting Release Gate

**Purpose**: Validate the complete feature without adding product scope.

- [ ] T041 Run the full security/architecture review and close only Feature 002 violations covering fixed-host requests, writer/verifier module isolation, immutable rows, no child-process/filesystem repository materialization, secret/content redaction, cancellation, and no-client-write paths in `tests/security/github-ingestion/`, `tests/security/transport/ssrf-and-execution-boundaries.test.ts`, and `tests/unit/observability/redaction.test.ts`
- [ ] T042 Run formatting, ESLint, strict typecheck, build, migrations, Feature 001 catalog/advisory verification, every Vitest project, evaluation thresholds, Actionlint, Compose validation, container readiness/restart/shutdown, deterministic fixture integrity, and `git diff --check` using `package.json`, `.github/workflows/ci.yml`, and `specs/002-github-catalog-ingestion/quickstart.md`; confirm no Feature 001 catalog/release/test fixture was modified

---

## Dependencies and Execution Order

### Slice Dependencies

```text
Phase 1 Setup
    ↓
Phase 2 Domain/ports/integrity foundation
    ↓
Slice 1: US2 registered exact-commit batch ingestion
    ↓
Slice 2: US1 discovery + US4 synchronization + US5 policy
    ↓
Slice 3: US3 unified MCP discovery/load/resource
    ↓
Final release gate
```

- Slice 1 is the MVP and can be stopped and validated independently.
- Slice 2 depends on Slice 1's exact object reader, source store, publisher, and fixtures. Within the
  slice, US1 discovery and US5 parser/policy work can proceed in parallel; US4 final synchronization
  integration depends on both plus the lease implementation.
- Slice 3 depends on the eligible imported PostgreSQL catalog produced by Slices 1–2. It does not
  introduce any GitHub call into an agent request.

### Within Each Slice

- Fixtures precede tests and implementations that consume them.
- Failing contract/unit/integration/security tests precede implementation.
- Domain types and canonical serialization precede migrations and stores.
- Migrations precede PostgreSQL stores; stores and readers precede services; services precede CLI or
  MCP composition.
- Atomic batch and slice checkpoint tests must pass before starting the next slice.

## Parallel Execution Examples

### Slice 1 / US2

After T006, run T007–T010 in parallel. After their failures are confirmed and T011 is applied, T012
and T013 can run in parallel; T014 then feeds T015–T016.

### Slice 2 / US1, US4, US5

After T017, run T018–T022 in parallel. T024 and T025 can then run in parallel. T026 and T023 complete
policy persistence before T027 integrates synchronization; T028 completes administration.

### Slice 3 / US3

After T030, run T031 and T032 in parallel. Once T033 provides the unified provider, complete T034 then
T035 before T036–T040 integrate the complete journey; T038 and T039 can proceed in parallel once the
runtime contract is stable.

## Independent Story Criteria

- **US1**: Bounded recorded discovery deduplicates canonical public repositories as discovered and
  never affects an agent search or visibility.
- **US2**: One registration imports the pinned 25-skill manifest as one atomic immutable batch with
  exact commit, paths, hashes, provenance, and per-skill results.
- **US3**: An authenticated agent completes preview search, exact load, and one declared resource in
  at most three calls with invocation filtering, repository-memory compatibility, and no client write.
- **US4**: Two exact commits prove changed/new/reused/removed behavior, fenced concurrency,
  cancellation, retry/rename/ETag handling, and byte-identical historical revisions.
- **US5**: Deterministic reports drive discovered/verified/quarantined transitions; only an explicit
  administrator can curate, and no transition mutates publication facts.

## Implementation Strategy

### MVP: Slice 1

Complete T001–T016, then stop and validate the pinned `mattpocock/skills` batch plus all Feature 001
tests. This produces a runnable registered-source ingestion capability without premature discovery or
agent-facing integration.

### Incremental Delivery

1. Slice 1 establishes exact, immutable, fixture-backed registered ingestion.
2. Slice 2 adds bounded automation and trust lifecycle without changing the registered import
   contract.
3. Slice 3 exposes only eligible immutable imports through the existing MCP operations.
4. T041–T042 are required release gates; the live GitHub smoke remains manual and nonblocking.

## Scope Guardrails

- Do not modify Feature 001 canonical bytes, releases, advisory files, or externally observable
  behavior except backward-compatible additive MCP fields for imported results.
- Do not add private repository support, GitHub Apps, configurable/arbitrary Git hosts, agent-facing
  source URLs, a frontend, marketplace/billing, Redis, separate workers, cloning, checkout, package
  execution, hooks, binaries, or local skill installation.
- Do not split tasks per skill or source file. The 25-skill acceptance import is one atomic batch with
  per-skill traceable observations and assertions.
