---

description: "Implementation tasks for Feature 003 autonomous skill activation"
---

# Tasks: Autonomous Skill Activation

**Input**: Design documents from `/specs/003-autonomous-skill-activation/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Tests are required by FR-031 through FR-036 and Constitution Principle VII. In each slice, fixture creation precedes consuming tests, and consuming tests precede implementation.

**Organization**: T001–T051 preserve the audited, compatible advisory-server implementation and its historical clean probe. Remaining work begins at T052 and is organized into the nine revised slices: reconciliation guards; plugin; marketplace; dependency safety; manager lifecycle; package integrity; paired cohorts; attributable claim gating; and release readiness. Model-dependent work remains outside required CI.

**Status legend**:

- `[X]` — already implemented and re-audited against the revised plan; its current acceptance criteria are demonstrably satisfied.
- `[ ]` — remaining work. Do not mark complete from planned behavior, model prose, or partial evidence.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel after the stated phase prerequisites because it changes different files and does not depend on another incomplete task in that group.
- **[Story]**: Maps the task to one of the five user stories in `spec.md`.
- Every task names the exact file or files it changes and the requirements/success criteria it verifies.

## Slice Traceability

| Slice | Phase/story mapping | Status | Primary requirements | Primary success criteria |
|-------|---------------------|--------|----------------------|--------------------------|
| Prior server/corpus/transport/memory implementation | Phases 1–8, T001–T051 | Complete advisory baseline | FR-001–043 | SC-004–013 |
| 1. Reconcile existing implementation and tests | Phase 9, shared foundation | Remaining guards | FR-018, FR-027–036, FR-043 | SC-008, SC-012–013 |
| 2. Minimal three-file Codex plugin | Phase 10 / US6 | Remaining | FR-044–048, FR-051–052 | SC-008, SC-014 |
| 3. SkillWire marketplace metadata | Phase 10 / US6 | Remaining | FR-044, FR-048–052 | SC-008, SC-014 |
| 4. MCP dependency and credential-safe failure | Phase 10 / US6 | Remaining | FR-024–026, FR-047–052 | SC-008–009, SC-014 |
| 5. Plugin-manager lifecycle | Phase 10 / US6 | Remaining | FR-044, FR-048–050, FR-052 | SC-008, SC-014 |
| 6. Packaging integrity and reproducibility | Phase 10 / US6 | Remaining | FR-046, FR-048, FR-052 | SC-008, SC-014 |
| 7. Fresh paired clean-profile cohorts | Phase 15 / US5 | Remaining, non-blocking CI | FR-037–043, FR-053 | SC-001–007, SC-011, SC-013, SC-015 |
| 8. Attributable traces and 80% claim gate | Phase 15 / US5 | Remaining | FR-040–043, FR-053 | SC-001–006, SC-010–011, SC-015 |
| 9. Documentation and release readiness | Phase 16, cross-cutting | Remaining | FR-018, FR-035–053 | SC-008–015 |

## Phase 1: Slice 1 — Immutable Activation Corpus and Deterministic Fixtures

**Purpose**: Freeze all synthetic identities, prompts, local-overlap declarations, failure cases, and manual-evidence samples before any implementation or consuming test is written.

**Independent Verification**: The committed activation fixture manifest resolves every exact server-side skill/revision/hash/resource identity, contains the required cohort minima and pairings, contains no private data or client-installed skill, and has stable checksums. No Feature 001 or Feature 002 fixture is changed.

- [X] T001 Create the immutable server-side catalog identity/resource fixture in `tests/fixtures/activation/catalog.v1.json`, referencing only existing verified first-party or recorded imported content and including exact revisions and SHA-256 values (FR-029–030; SC-008, SC-011)
- [X] T002 Create the metadata-only local overlap inventory in `tests/fixtures/activation/local-inventory.v1.json` with at least five predeclared equivalent/overlapping cases and explicit-selection flags, without adding any local `SKILL.md` or client installation artifact (FR-028–029; SC-007)
- [X] T003 Create `evaluation/autonomous-activation.v1.json` with at least 25 automatic-relevant prompts, 15 irrelevant prompts, 10 explicit user-requested cases plus paired no-intent variants, useful/no-resource cases, bounded expected traces, failure expectations, and exact identities from T001/T002 (FR-027–030; SC-003–006, SC-011)
- [X] T004 Create `tests/fixtures/activation/manifest.v1.json` containing the corpus, catalog, and local-inventory version identifiers and SHA-256 checksums so in-place fixture mutation fails validation instead of silently changing expectations (FR-029–030, FR-034; SC-008, SC-011)
- [X] T005 [P] Create valid and incomplete privacy-safe evidence fixtures in `tests/fixtures/activation/manual-evidence-valid.v1.json` and `tests/fixtures/activation/manual-evidence-incomplete.v1.json`, referencing frozen case IDs without copying prompt/task text (FR-040–042; SC-010–011)
- [X] T006 [P] Create deliberately invalid privacy, repeated-search, local-override, and unsupported-positive-outcome evidence cases in `tests/fixtures/activation/manual-evidence-invalid.v1.json` for later validator tests (FR-039, FR-041–042; SC-005, SC-007, SC-010)
- [X] T007 Write fixture-first failing validation tests in `tests/unit/evaluation/activation-corpus.test.ts` for JSON-schema constants, checksum integrity, unique IDs/pairs, cohort minima, exact catalog/resource resolution, local-overlap declarations, privacy-safe prompts, and expected call bounds (FR-027–030, FR-034; SC-005–008, SC-011)
- [X] T008 Implement the Zod loader and structural/semantic fixture validator in `src/evaluation/activation-corpus-runner.ts`, mirroring `specs/003-autonomous-skill-activation/contracts/activation-corpus.schema.json` and making T007 pass without changing frozen expectations (FR-027–030, FR-034; SC-008, SC-011)

**Checkpoint — Slice 1**: `pnpm exec vitest run --project unit tests/unit/evaluation/activation-corpus.test.ts` passes against immutable, synthetic fixtures created before the test and runner.

---

## Phase 2: Completed Portable Advisory Policy Baseline

**Purpose**: Establish one static, client-agnostic advisory policy source before exposing it through either MCP protocol era. Publication improves tool selection but does not guarantee autonomous invocation.

**Critical prerequisite**: Phase 1 is complete. No user-story transport work starts until this policy foundation passes independently.

**Independent Verification**: Unit tests prove one versioned policy, an exact 493-code-point decision capsule, a 997-code-point full instruction value, prefix identity, required trigger/non-trigger/context/privacy concepts, and absence of client-specific or dynamic content.

- [X] T009 Write failing policy contract tests in `tests/unit/transport/activation-policy.test.ts` for version `skillwire-activation-v1`, Unicode code-point bounds, exact prefix composition, specialized triggers, trivial/local/repeated non-triggers, automatic versus explicit context, fail-open/no-retry workflow, inert/no-install behavior, and forbidden client/path/credential text (FR-001–007; SC-005, SC-009, SC-012)
- [X] T010 Implement `ACTIVATION_POLICY_VERSION`, `ACTIVATION_DECISION_CAPSULE`, and `ACTIVATION_INSTRUCTIONS` as static immutable exports in `src/transport/mcp/activation-policy.ts`, using the exact normative text in `contracts/mcp-activation.md` and no client/tenant/catalog branching (FR-001–007, FR-018; SC-012)

**Checkpoint — Slice 2**: `pnpm exec vitest run --project unit tests/unit/transport/activation-policy.test.ts` passes without starting the HTTP server or reading a live catalog.

---

## Phase 3: Completed Advisory Metadata and Scripted MCP Journey / User Story 1 (Priority: P1)

**Goal**: Publish the same advisory policy through legacy `initialize` and modern `server/discover`, then prove the real MCP preview -> exact load -> optional resource path in a clean temporary client tree without treating the scripted path as spontaneous activation.

**Independent Test**: Connect through each protocol era, compare the observed instruction values, and use an official MCP client to record actual `search_skills(automatic)`, exact `load_skill`, and optional declared `read_skill_resource` calls. Verify one fixture needs a resource and one completes from primary instructions only.

### Tests for User Story 1 — write before implementation

- [X] T011 [US1] Add a failing legacy 2025-11-25 initialize contract case to `tests/contract/mcp/activation-metadata.test.ts` that asserts `client.getInstructions()` equals the centralized policy and retains a sufficient first 512-code-point prefix (FR-001–002, FR-031; SC-008, SC-012)
- [X] T012 [US1] Add a failing modern 2026-07-28 `server/discover` HTTP contract case and a semantic/exact equality assertion against legacy initialize in `tests/contract/mcp/activation-metadata.test.ts`, using the real handler rather than a mocked result (FR-001–002, FR-031; SC-008, SC-012)
- [X] T013 [US1] Add failing clean-tree positive journey cases to `tests/e2e/autonomous-activation-transport.test.ts` that record actual MCP calls for both search -> exact load and search -> exact load -> one declared resource, assert exact hash/provenance/advisory fields, and assert no unnecessary resource call (FR-013–015, FR-025, FR-033; SC-005–006, SC-008–009)

### Implementation for User Story 1

- [X] T014 [US1] Add official-client protocol negotiation, in-process fetch, fresh temporary client-tree digest, and ordered tool-call recording support to `tests/helpers/activation-mcp-harness.ts` so T011–T013 exercise registered MCP transport rather than use cases (FR-031, FR-033, FR-036; SC-005–006, SC-008–009)
- [X] T015 [US1] Pass `ACTIVATION_INSTRUCTIONS` as `ServerOptions.instructions` in `src/transport/mcp/server-factory.ts` while preserving the existing stateless handler, six-tool inventory, authentication pipeline, and clients that ignore instructions (FR-001, FR-018, FR-024; SC-008–009, SC-012)

**Checkpoint — advisory US1 baseline**: The focused contract and E2E tests show semantically identical legacy/current instructions and real registered search/load/resource operations. This demonstrates only the server-controlled journey, not spontaneous model choice.

---

## Phase 4: Slice 4A / User Story 2 — Avoid Unnecessary and Repeated Activation (Priority: P1)

**Goal**: Preserve the positive relevance boundary and encode/test advisory one-attempt behavior so trivial, irrelevant, empty, or failed activation paths do not lead to unrelated results or loops.

**Independent Test**: Frozen irrelevant prompts rank to no eligible result; repository memory cannot revive a zero-score result; actual MCP search returns `{ skills: [] }` and no load follows; a deterministic trace validator rejects repeated searches, query reformulation, polling, second candidates, duplicate paths, and retry after failure.

### Tests for User Story 2 — write before implementation

- [X] T016 [P] [US2] Extend `tests/unit/domain/ranking.test.ts` with failing assertions for exported threshold value `1`, zero-score exclusion before limiting, relevance before memory, stable ties, and unchanged positive-match ordering (FR-019–020; SC-003, SC-008–009)
- [X] T017 [P] [US2] Extend `tests/unit/evaluation/activation-corpus.test.ts` with failing trace cases for repeated/reformulated search, polling, second candidate/revision, duplicate resource path, retry after no-result/error, and materially new task intent (FR-003–005, FR-020, FR-024; SC-005–006, SC-009)
- [X] T018 [US2] Add failing exact `search_skills` description/annotation assertions to `tests/contract/mcp/activation-metadata.test.ts`, covering specialized trigger, local/loaded non-trigger, automatic context, minimal non-sensitive summary, preview-only result, empty-final behavior, and no retry/reformulation (FR-008–010, FR-020; SC-003, SC-008–009)
- [X] T019 [US2] Add an actual-transport no-result case to `tests/e2e/autonomous-activation-transport.test.ts` that records one automatic search, an empty result, zero load/resource/memory/outcome calls, and an unchanged temporary client tree (FR-020, FR-024–025, FR-033; SC-003, SC-005, SC-009)

### Implementation for User Story 2

- [X] T020 [US2] Export `MINIMUM_RELEVANCE_SCORE = 1` and replace the literal positive-score predicate in `src/domain/catalog/ranking.ts` without changing tokenization, weights, sorting, memory influence, or result schemas (FR-019–020; SC-003, SC-008)
- [X] T021 [US2] Extend `src/evaluation/activation-corpus-runner.ts` with deterministic advisory trace validation and reason codes for repeated calls, retries, reformulation, second loads, duplicate resources, and calls after terminal no-result/error states (FR-005, FR-020, FR-024; SC-005–006, SC-009)
- [X] T022 [US2] Add the exact centralized `search_skills` description and standard annotations to `src/transport/mcp/activation-policy.ts`, keeping cross-tool policy in server instructions rather than duplicating it (FR-008–010, FR-020; SC-003, SC-008)
- [X] T023 [US2] Make the `search_skills` registration consume its centralized metadata in `src/transport/mcp/tool-adapters.ts` without changing its title, input/output schemas, default automatic context, handler, or error envelope (FR-008–011, FR-018; SC-003–004, SC-008)

**Checkpoint — US2 / Slice 4A**: Ranking, metadata, trace-policy, and actual no-result tests pass. Repetition is correctly identified as advisory/evaluator-enforced rather than falsely claimed as stateless-server session enforcement.

---

## Phase 5: Slice 4B / User Story 3 — Preserve Automatic/User-Requested Isolation (Priority: P1)

**Goal**: Complete all six operation descriptions/annotations and prove that automatic context cannot reveal user-only skills while explicit user-requested context can include the frozen exact match.

**Independent Test**: For every frozen pair, automatic/default context returns no user-only match and explicit user-requested context returns the expected eligible exact revision. `tools/list` reports exact metadata for all six existing tools and no schema/name changes.

### Tests for User Story 3 — write before implementation

- [X] T024 [P] [US3] Add failing exact descriptions/standard-annotation assertions for `load_skill`, `read_skill_resource`, `list_repo_memory`, `record_skill_outcome`, and `forget_repo_memory` plus exact six-tool/schema inventory assertions in `tests/contract/mcp/activation-metadata.test.ts` (FR-008, FR-014–018; SC-006, SC-008, SC-010)
- [X] T025 [P] [US3] Extend `tests/contract/mcp/search-skills.test.ts` with frozen paired cases proving omitted/automatic context excludes the strongest user-only match, explicit user-requested context includes it, and other tenant/relevance/eligibility rules still apply (FR-009–012, FR-019–020; SC-004, SC-008)
- [X] T026 [US3] Add actual-transport paired isolation traces to `tests/e2e/autonomous-activation-transport.test.ts`, asserting no context escalation or load in the no-intent case and the expected exact preview/load only in the explicit case (FR-010–012, FR-024, FR-033; SC-004–005, SC-009)

### Implementation for User Story 3

- [X] T027 [US3] Add the remaining five exact descriptions and conservative standard annotation maps to `src/transport/mcp/activation-policy.ts`, including load-side memory effects, evidence-gated useful outcomes, opaque-hash privacy, and erasure semantics (FR-008, FR-014–018; SC-006, SC-008, SC-010)
- [X] T028 [US3] Make the remaining five registrations consume centralized metadata in `src/transport/mcp/tool-adapters.ts` while preserving all six names, titles, Zod schemas, handlers, authorization, safe errors, and operation contracts (FR-008, FR-018, FR-024; SC-008–009)

**Checkpoint — US3 / Slice 4B**: All frozen explicit/no-intent pairs enforce 100% isolation, and `tools/list` proves the exact unchanged six-operation surface with accurate advisory metadata.

---

## Phase 6: Slice 5 / User Story 4 — Verified-Load Attribution and Repository Memory (Priority: P2)

**Goal**: Ensure only an exact, provenance-bearing, advisory-checked SkillWire load can create repository usage and that local guidance, previews, failed loads, and resource reads cannot be misattributed.

**Independent Test**: With an opaque repository hash, exact verified load records one usage; search alone, provider identity mismatch, revoked/unavailable/invalid/cancelled load, local-only trace, and resource read record none. A later resource failure leaves the preceding verified usage intact, and outcomes still require an existing attributable row.

### Tests for User Story 4 — write before implementation

- [X] T029 [P] [US4] Add failing load contract cases for provider-returned identity/revision mismatch, invalid verified fields, and pre-memory cancellation in `tests/contract/mcp/load-skill.test.ts`, asserting safe errors and zero memory writes (FR-014, FR-017, FR-024; SC-005, SC-009)
- [X] T030 [P] [US4] Add PostgreSQL service integration cases in `tests/integration/service/activation-memory-attribution.test.ts` for exact account/hash/skill/revision attribution, no row after search or failed load, no extra row after resource read, resource-failure retention, cross-tenant isolation, and existing-row-only outcomes (FR-016–017, FR-022, FR-024; SC-007, SC-009–010)
- [X] T031 [P] [US4] Add actual MCP memory traces and local-guidance/no-load evidence cases to `tests/e2e/autonomous-activation-transport.test.ts`, asserting local names/previews are not verified loads and temporary client trees remain unchanged (FR-014, FR-017, FR-021–022, FR-025, FR-033; SC-007, SC-009)

### Implementation for User Story 4

- [X] T032 [US4] Extend `tests/helpers/memory-store.ts` with observable record counts, deterministic failure injection, and scope inspection needed by T029/T031 without weakening its existing Feature 001/002 semantics (FR-017, FR-024; SC-009)
- [X] T033 [US4] Refactor `src/application/use-cases/load-skill.ts` to construct the full result, reassert requested exact identity and verified hash/provenance/advisory invariants, call the existing request-active guard, and only then invoke `recordUsage`, preserving optional memory and non-atomic post-commit delivery documentation (FR-014, FR-017, FR-024; SC-005, SC-009)

**Checkpoint — US4 / Slice 5**: Memory tests prove zero records without a verified exact load, no local/preview misattribution, preserved tenant scoping, and correct retention after a later resource failure.

---

## Phase 7: User Story 5 — Evaluate Activation Reproducibly (Priority: P2)

**Goal**: Provide deterministic offline server/transport evaluation plus a separate privacy-safe, non-blocking protocol for real MCP-capable harness measurements.

**Independent Test**: Required CI validates frozen fixtures, both protocol eras, metadata, filtering, actual calls, failure/loop/privacy invariants, and all prior regression suites with no live credentials. Separately, the manual evidence validator recomputes metrics and rejects privacy leaks, incomplete-as-success cases, unsupported positive outcomes, and conflated local-overlap cohorts.

### Slice 6 — Deterministic server-side evaluation and regression coverage

#### Tests — write before implementation

- [X] T034 [P] [US5] Add failing full-corpus deterministic evaluation tests in `tests/evaluation/autonomous-activation.test.ts` for immutable expected matches, automatic/user-requested filtering, no-match outcomes, expected operation bounds, progressive-resource cases, and separately grouped overlap fixtures (FR-027–036; SC-004–009, SC-011)
- [X] T035 [P] [US5] Extend `tests/e2e/autonomous-activation-transport.test.ts` with actual-transport unavailable-service, authentication, rate-limit, timeout, exact-load-unavailable, memory-failure, and resource-failure traces, asserting one attempt, no retry/escalation/substitution/second candidate, and correct memory behavior (FR-024, FR-033, FR-036; SC-005–006, SC-008–009)
- [X] T036 [P] [US5] Add security boundary tests in `tests/security/transport/autonomous-activation-boundaries.test.ts` for zero agent-facing GitHub calls, exact six-tool inventory, no client-tree writes, no execution/install/write primitives in activation paths, safe log/evidence fields, and untrusted inert content (FR-023–026, FR-032–036; SC-008–010)

#### Implementation

- [X] T037 [US5] Extend `src/evaluation/activation-corpus-runner.ts` with deterministic catalog-match evaluation, context filtering assertions, expected trace comparison, categorical failure handling, and reproducible cohort/denominator calculation without invoking a model or live network (FR-030, FR-033–036; SC-004–009, SC-011)
- [X] T038 [US5] Extend `tests/helpers/activation-mcp-harness.ts` with controlled service/auth/rate/deadline/provider/resource/memory failures, operation caps, GitHub-call counting, and before/after client-tree snapshots so T034–T036 prove real registered calls and fail-open traces (FR-023–025, FR-033, FR-036; SC-005–009)
- [X] T039 [US5] Add a deterministic-only `test:activation` script to `package.json` that runs the Feature 003 unit, contract, E2E, evaluation, and security files without invoking a model, live GitHub, or manual evidence collection (FR-031–036; SC-008–009)
- [X] T040 [US5] Update `.github/workflows/ci.yml` to include branch `003-autonomous-skill-activation`, run the deterministic activation script with GitHub ingestion/network disabled, retain every existing Feature 001/002 test project, and require no Codex/harness credentials (FR-035–036; SC-008–009)

**Checkpoint — Slice 6**: `pnpm test:activation` and every existing `pnpm test:*` project pass offline; the CI workflow has no live model/manual step and retains the complete Feature 001/002 regression surface.

### Slice 7 — Non-blocking manual evaluation with a real MCP-capable harness

#### Tests — write before implementation

- [X] T041 [P] [US5] Add failing semantic evidence tests in `tests/unit/evaluation/manual-evidence.test.ts` using T005/T006 for version binding, ordered actual calls, unique sequences, verified-load attribution, completion/feedback-gated useful outcomes, incomplete cases, privacy declarations, cohort separation, and recomputed denominators (FR-037–043; SC-001–004, SC-007, SC-010–011)
- [X] T042 [P] [US5] Add failing CLI contract tests in `tests/contract/cli/activation-evidence.test.ts` for validate/summarize success, stable JSON output, safe diagnostics, schema failure, nonzero exit status, and zero raw prompt/repository/content echo (FR-040–043; SC-010–011)

#### Implementation and manual protocol

- [X] T043 [US5] Implement the manual evidence Zod loader, semantic trace validator, privacy checks, incomplete-case handling, local-overlap separation, and metric recomputation in `src/evaluation/activation-evidence.ts`, mirroring `contracts/manual-evidence.schema.json` without trusting submitted aggregate rates (FR-037–043; SC-001–004, SC-007, SC-010–011)
- [X] T044 [US5] Implement the offline `validate` and `summarize` commands in `scripts/activation-evidence.ts`, accepting only an operator-supplied evidence path and never launching/configuring a harness, touching a client tree, or entering required CI (FR-037, FR-040–043; SC-010–011)
- [X] T045 [US5] Document fresh-session clean-profile, explicit-intent pair, local-overlap, failure, trace-redaction, version-recording, and acceptance-metric procedures in `docs/autonomous-activation-evaluation.md`, explicitly stating that instructions are advisory and GUIs/launchers/configuration are outside the boundary (FR-037–043; SC-001–004, SC-007, SC-010–011)
- [X] T046 [US5] Execute the historical server-instructions-only probe with a real named MCP-capable harness/model, validate the privacy-safe negative evidence in `evaluation/evidence/003/candidate-v1.json`, and preserve its exact `0/7` result and SHA-256 `04cd236d6ddd27f30c21f7d332577ef3a91a3f55fc6ab79d1fd1f02d4900db2d` without relabeling it as adapter evidence (FR-037–043; SC-010–013)

  **Blocked evidence (2026-08-12)**: the genuinely isolated Codex CLI `0.147.0` / `gpt-5.6-sol` / `xhigh` probe produced `0/7` spontaneous activations with exact modern instructions and the six-tool inventory observed server-side. Seven misses make the 30-case clean-cohort maximum `23/30` (`76.7%`), below SC-001's `80%`; one additional latency-bound case is incomplete. The validated negative artifact is `evaluation/evidence/003/candidate-v1.json`. No success was inferred from prose.

**Checkpoint — historical evidence**: `scripts/activation-evidence.ts validate` accepts the negative artifact and reproduces `0/7` from per-case traces. T046 is complete as a falsifying server-only measurement, not as autonomous-activation success; the artifact remains outside required CI and can never satisfy the adapter claim gate.

---

## Phase 8: Completed Advisory-Baseline Documentation and Readiness Record

**Purpose**: Explain the additive server behavior, operational boundaries, privacy model, compatibility, rollback, and evidence requirements; then execute every release gate without changing Features 001 or 002.

**Independent Verification**: A reviewer can reproduce all deterministic checks from documentation, confirm no schema/tool/migration/client/UI expansion, and inspect a release-readiness record that distinguishes deterministic pass/fail from optional manual measurements.

- [X] T047 [P] Document the portable advisory server instructions, harness limitations, preview -> exact load -> progressive resource ordering, automatic/user-requested context, local precedence, and no-install/fail-open boundaries in `README.md` without claiming server-only autonomous invocation or adding client-specific repository configuration (FR-001–018, FR-021–026; SC-005–010, SC-012)
- [X] T048 [P] Document the advisory-server rollout, both protocol eras, safe rollback, rate/deadline/unavailability behavior, existing privacy-safe observability, and deterministic-versus-manual evidence boundary in `docs/operations.md` (FR-018, FR-023–024, FR-031–043; SC-008–013)
- [X] T049 [P] Document minimal task-summary guidance, prohibited evidence/log fields, opaque-hash-only memory, verified-load attribution, local-skill non-attribution, retention/erasure continuity, and zero server-driven client writes in `docs/privacy.md` (FR-006, FR-014, FR-016–018, FR-022, FR-025, FR-041; SC-007, SC-009–011)
- [X] T050 [P] Reconcile the completed advisory-server commands, actual transported traces, failure checks, v1 manual-evidence validation, and target calculations in `specs/003-autonomous-skill-activation/quickstart.md` while preserving the no-live-credentials CI boundary (FR-031–043; SC-001–013)
- [X] T051 Run and record the completed advisory-baseline formatting, lint, typecheck, build, `test:activation`, and unit/contract/integration/E2E/evaluation/security regressions in `specs/003-autonomous-skill-activation/release-readiness.md`, including zero new tools/migrations/repository activation files/UI changes and the separate historical negative evidence (FR-018, FR-023–026, FR-035–043; SC-008–013)

**Checkpoint — completed baseline record**: The advisory-server implementation and its historical negative probe are auditable. This checkpoint does not cover the new plugin, marketplace, lifecycle, or paired-adapter claim gate; those remain T052–T106.

---

## Phase 9: Slice 1 — Reconcile the Existing Feature 003 Baseline

**Purpose**: Turn the compatible server implementation and historical negative probe into explicit immutable regression inputs before any adapter implementation consumes them.

**Independent Verification**: Focused unit/contract/E2E/evaluation/security tests and the PostgreSQL attribution test pass; `evaluation/autonomous-activation.v1.json` remains 75 cases at SHA-256 `a06e1ced82026bf007e0f1d9ee53c0a57c526cf59784285098a2840cb13e8b28`; `candidate-v1.json` remains the validated server-only `0/7` artifact at its contracted hash; and no plugin or marketplace path is imported by application code.

- [X] T052 Add an immutable baseline regression test in `tests/unit/evaluation/activation-baseline.test.ts` that asserts the exact corpus and `evaluation/evidence/003/candidate-v1.json` hashes, validates the historical artifact with the existing v1 validator, and proves its `0/7` result remains server-only negative evidence (FR-027–030, FR-043; SC-011, SC-013)
- [X] T053 [P] Extend `tests/security/transport/autonomous-activation-boundaries.test.ts` to reject imports or writes from `src/` into `integrations/codex`, `distribution/codex-marketplace`, `.codex`, `.agents`, `CODEX_HOME`, or Codex plugin-cache paths while retaining the existing six-tool/no-client-write checks (FR-018, FR-025–026, FR-051; SC-008–009, SC-014)
- [X] T054 [P] Extend `tests/contract/mcp/activation-metadata.test.ts` with explicit assertions that server instructions and tool metadata are advisory, clients may ignore them, explicit MCP operation remains available without the adapter, and all six existing names/titles/input/output schemas remain unchanged (FR-001, FR-008, FR-018, FR-031; SC-008, SC-012)
- [X] T055 Create privacy-safe paired-evidence fixtures before their consuming tests in `tests/fixtures/activation/paired-evidence-valid.v1.json` and `tests/fixtures/activation/paired-evidence-invalid.v1.json`, binding the historical baseline hash, identical non-overlap case sets and experiment controls, categorized inventories, exact public identities, and no raw prompts/paths/credentials/content (FR-037–043, FR-053; SC-010–013, SC-015)
- [X] T056 Add failing paired-envelope structural tests using T055 in `tests/unit/evaluation/manual-evidence.test.ts`, preserving every existing v1 evidence case while covering both embedded runs, baseline binding, inventory differences, and schema rejection before paired-validator implementation (FR-037, FR-040–043; SC-011, SC-013)

**Checkpoint — Slice 1**: Existing Feature 003 behavior is locked as the advisory baseline; T001–T051 remain demonstrably complete, and all subsequent work can change only adapter/evidence surfaces unless a focused baseline test exposes a genuine Feature 003 defect.

---

## Phase 10: Slices 2–6 / User Story 6 — Manage the Optional Codex Activation Adapter (Priority: P1)

**Goal**: Produce and deterministically validate the exact three-file plugin, exact-SHA marketplace metadata, credential-free MCP dependency, Codex-managed lifecycle, and reproducible release integrity without any SkillWire application write into Codex-managed or repository paths.

**Independent Test**: In restrictive disposable `HOME`/`CODEX_HOME` directories and an unrelated empty temporary Git repository, the pinned Codex manager lists, installs, verifies, upgrades, rolls back, and removes one adapter identity; installed bytes match the integrity manifest; dependency failures degrade safely; no credential is printed; the repository digest never changes; and uninstall leaves zero adapter-owned files while preserving external MCP configuration.

### Slice 2 — Minimal three-file plugin

- [X] T057 [P] [US6] Write failing exact-inventory and schema tests in `tests/unit/evaluation/codex-adapter-package.test.ts` for only `.codex-plugin/plugin.json`, `skills/autonomous-skill-activation/SKILL.md`, and `skills/autonomous-skill-activation/agents/openai.yaml`, rejecting extra files, links, non-UTF-8 content, executable bits, hard links, hidden siblings, scripts, hooks, assets, package-manager files, catalog data, and remote skill content (FR-044–046, FR-048, FR-051–052; SC-008, SC-014)
- [X] T058 [US6] Implement the strict package inventory, JSON/YAML/frontmatter, path, regular-file, encoding, mode, link, name, and semantic-version validator in `src/evaluation/codex-adapter-package.ts` so T057 fails only because the package files do not yet exist (depends on T057; FR-044–046, FR-048, FR-052; SC-008, SC-014)
- [X] T059 [P] [US6] Create the exact `skillwire-autonomous-activation` v0.1.0 manifest in `integrations/codex/skillwire-autonomous-activation/.codex-plugin/plugin.json` with only `name`, `version`, `description`, and `skills: "./skills/"` (depends on T057; FR-044, FR-046, FR-048, FR-051; SC-014)
- [X] T060 [P] [US6] Create the content-free activation skill in `integrations/codex/skillwire-autonomous-activation/skills/autonomous-skill-activation/SKILL.md` with exact frontmatter, adapter policy version, narrow triggers/non-triggers, local precedence, one-attempt workflow, automatic/explicit context, exact-load attribution, progressive resources, inert-content/privacy rules, outcome evidence, and fail-open behavior—but no catalog identity, remote skill content, executable instruction, credential, or repository modification command (depends on T057; FR-003–007, FR-014–017, FR-021–026, FR-045–046, FR-051; SC-005–010, SC-014–015)
- [X] T061 [P] [US6] Create `integrations/codex/skillwire-autonomous-activation/skills/autonomous-skill-activation/agents/openai.yaml` with only the contracted interface fields, `products: [CODEX]`, `allow_implicit_invocation: true`, and one credential-free `streamable_http` MCP dependency named `skillwire` at the approved canonical HTTPS endpoint (depends on T057; FR-044–048, FR-051; SC-008, SC-014)
- [X] T062 [US6] Extend `src/evaluation/codex-adapter-package.ts` and T057 tests with cross-surface semantic checks that the plugin reproduces—but does not broaden—the versioned server policy, contains no remote skill payload, and cannot implement search/ranking/load/resource/auth/memory behavior itself; then make the complete three-file package test pass (depends on T058–T061; FR-032, FR-045–046, FR-051–052; SC-008, SC-014)

### Slice 3 — SkillWire marketplace metadata

- [X] T063 [P] [US6] Write failing marketplace contract tests in `tests/unit/evaluation/codex-marketplace.test.ts` for marketplace `skillwire`, one matching plugin entry, `git-subdir`, credential-free HTTPS Git URL, `./`-prefixed in-repository path, exact lowercase 40-character source SHA, `AVAILABLE`, `ON_USE`, `Developer Tools`, and rejection of mutable refs/placeholders/mismatched identities/extra entries (FR-044, FR-048–052; SC-008, SC-014)
- [X] T064 [US6] Add marketplace parsing and validation to `src/evaluation/codex-adapter-package.ts`, including exact plugin/manifest identity, path containment, Git source/SHA, policy, category, and no-secret checks, using generated temporary marketplace roots rather than a checked-in repository-scoped `.agents/plugins` file (depends on T063; FR-044, FR-048, FR-051–052; SC-008, SC-014)

### Slice 4 — MCP dependency declaration and credential-safe failures

- [X] T065 [P] [US6] Add failing dependency contract cases to `tests/unit/evaluation/codex-adapter-package.test.ts` for the exact documented `type`, `value`, `description`, `transport`, and canonical URL fields and rejection of `.mcp.json`, required-startup semantics, URL userinfo/query/fragment, placeholders, tenant/account/repository identifiers, keys, tokens, bearer values, credential fields, and additional dependencies (FR-024–026, FR-047, FR-051–052; SC-008–009, SC-014)
- [X] T066 [US6] Extend `src/evaluation/codex-adapter-package.ts` to enforce T065 while treating credentials as external Codex-managed connection state and never reading, copying, printing, deleting, or materializing protected values (depends on T061, T065; FR-047–048, FR-051–052; SC-008–009, SC-014)

### Slice 5 — Codex plugin-manager lifecycle

- [X] T067 [US6] Pin the official Codex CLI/plugin manager version `0.147.0` as a deterministic development-only tool in `package.json` and `pnpm-lock.yaml`, with no production/runtime dependency and no normal user profile lookup (FR-044, FR-052; SC-008, SC-014)
- [X] T068 [US6] Write the initial failing manager contract in `tests/contract/cli/codex-activation-plugin.test.ts` for temporary marketplace add/list, available-plugin listing, plugin add, installed listing, effective skill/MCP inventory, exact single identity/version, installed hashes, restrictive profile permissions, zero credential output, and unchanged unrelated repository digest (depends on T063, T067; FR-044, FR-048, FR-052; SC-008, SC-014)
- [X] T069 [US6] Implement `tests/helpers/codex-plugin-manager-harness.ts` to resolve only the pinned manager, create mode-0700 disposable `HOME`/`CODEX_HOME` and an empty out-of-tree Git repository, materialize the release catalog only inside the disposable marketplace fixture, pass an allowlisted environment, redact outputs, snapshot inventories/hashes, and clean up without direct application writes (depends on T068; FR-025, FR-044, FR-048, FR-052; SC-009, SC-014)
- [X] T070 [US6] Extend `tests/contract/cli/codex-activation-plugin.test.ts` with deterministic equivalent-existing, manager-added, absent/declined, same-name/different-URL, unavailable, unauthenticated, incompatible, rate-limited, and timed-out dependency cases, asserting one effective binding, no overwrite, no retry/prompt loop, safe diagnostics, and ordinary/explicit MCP behavior remaining available (depends on T066, T069; FR-024, FR-047–052; SC-005, SC-008–009, SC-014)
- [X] T071 [US6] Extend `tests/contract/cli/codex-activation-plugin.test.ts` with a generated v0.1.1 marketplace snapshot and interrupted/invalid upgrade cases, asserting `marketplace upgrade` leaves one verifiable identity, replaces prior files on success, retains no obsolete files, and restores the previous valid state on failure without cache editing (depends on T069; FR-049, FR-052; SC-008, SC-014)
- [X] T072 [US6] Extend `tests/contract/cli/codex-activation-plugin.test.ts` with plugin removal and optional marketplace removal, asserting zero adapter-owned files afterward, unchanged repositories, no remote skill cache, no credential output/deletion, preserved independent SkillWire MCP configuration, and restored server-only explicit operation (depends on T069; FR-044, FR-050, FR-052; SC-008–009, SC-014)
- [X] T073 [US6] Complete `tests/helpers/codex-plugin-manager-harness.ts` failure injection, manager-output normalization, effective-source inspection, upgrade rollback, and cleanup behavior needed to make T068–T072 pass using only `codex plugin marketplace ...`, `codex plugin ...`, and read-only `codex mcp list` operations (depends on T070–T072; FR-044, FR-047–052; SC-008–009, SC-014)

### Slice 6 — Packaging integrity and reproducibility

- [X] T074 [P] [US6] Add failing integrity/reproducibility tests to `tests/unit/evaluation/codex-adapter-package.test.ts` for lexicographically ordered path/SHA-256 lines, aggregate package SHA-256, exact three-file inventory, validator/manager versions, repeated-build identity, source path containment, source-commit binding, and rejection of stale hashes or package byte changes without a semantic version change (FR-046, FR-048–049, FR-052; SC-008, SC-014)
- [X] T075 [US6] Implement deterministic `validate` and `manifest` commands in `scripts/codex-adapter-package.ts` backed by `src/evaluation/codex-adapter-package.ts`, emitting only safe stable JSON, performing no install/network/profile write, and producing byte-identical integrity metadata for identical inputs (depends on T074; FR-046, FR-048, FR-052; SC-008, SC-014)
- [X] T076 [US6] After an immutable plugin-source commit exists, create `distribution/codex-marketplace/release-integrity.json` with the exact plugin/adapter versions, source URL/path/commit, three ordered file hashes, aggregate hash, and pinned validator/manager versions; do not mark complete for placeholders, a commit that lacks the package, or mismatched bytes (depends on T062, T075 and release-source commit availability; FR-046, FR-048–049, FR-052; SC-008, SC-014)
- [X] T077 [US6] After T076, create `distribution/codex-marketplace/marketplace.json` with the exact credential-free source URL/path/commit and contracted policies, then prove the dedicated marketplace publication can consume it without adding `.agents/plugins`, `.codex`, or other activation/configuration files to this repository (depends on T064, T076; FR-044, FR-048–052; SC-008, SC-014)
- [X] T078 [US6] Add a deterministic `test:activation-adapter` script to `package.json` that runs package, marketplace, dependency, integrity, and manager lifecycle tests with no model/live SkillWire/live GitHub calls or credentials, and verify it leaves the working repository digest unchanged (depends on T062–T077; FR-036, FR-052; SC-008–009, SC-014)

  **Immutable source evidence (2026-08-12)**: T076–T078 were rerun against detached source commit `8c7c297a95cff42eb13212fc7b5c4ede11c35c7d`. Two independent manifests were byte-identical, the three-file package hash was `7939fa2ca5db807365a9f54c90534538291c09bbfae56762e72f372447998830`, and the official Codex `0.147.0` manager lifecycle suite passed install, inventory/hash verification, invalid-upgrade rollback, valid upgrade, removal, and marketplace removal in disposable profiles with no repository or remote-skill-content writes.

**Checkpoint — US6 / Slices 2–6**: The exact three-file adapter and exact-SHA marketplace pass static and real manager validation; install/upgrade/rollback/uninstall are manager-owned; application code has no Codex-directory write path; and no catalog content or credential is present locally.

---

## Phase 11: Adapter-Assisted User Story 1 — Discover and Load Relevant Guidance (Priority: P1) 🎯 MVP

**Goal**: Verify that the installed adapter exposes narrowly scoped implicit guidance for specialized clean-profile tasks and directs the unchanged attributable MCP workflow without implementing remote-skill behavior itself.

**Independent Test**: Static adapter semantics cover every automatic-relevant trigger; an installed-package inventory identifies exactly one adapter skill; and deterministic transport evidence still proves preview -> exact verified load -> optional useful declared resource. These checks do not count as spontaneous model activation.

- [X] T079 [P] [US1] Add failing adapter-trigger and workflow tests in `tests/unit/evaluation/codex-adapter-package.test.ts` for specialized-task matching, no local/loaded guidance, one minimal automatic-context search, one selected preview, exact immutable load, provenance/hash/advisory attribution, optional next useful resource, and fail-open continuation (FR-003–007, FR-013–015, FR-024, FR-045, FR-051; SC-005–006, SC-008–009, SC-015)
- [X] T080 [US1] Refine only `integrations/codex/skillwire-autonomous-activation/skills/autonomous-skill-activation/SKILL.md` as needed to make T079 pass while preserving the exact package boundary and avoiding corpus-specific examples or remote skill content (depends on T079; FR-003–007, FR-013–015, FR-045–046, FR-051; SC-005–006, SC-014–015)
- [X] T081 [US1] Extend `tests/evaluation/autonomous-activation.test.ts` with deterministic adapter-to-server conformance for all non-overlap automatic-relevant frozen cases and actual recorded MCP sequences from `tests/helpers/activation-mcp-harness.ts`, explicitly asserting that adapter availability/prose alone never counts as activation (depends on T062, T080; FR-032–034, FR-045, FR-051–053; SC-005–006, SC-008, SC-015)

**Checkpoint — US1**: Plugin semantics and registered transport agree on the exact attributable workflow, while spontaneous selection remains reserved for Phase 15 evidence.

---

## Phase 12: Adapter-Assisted User Story 2 — Avoid Unnecessary Activation (Priority: P1)

**Goal**: Ensure the adapter description/body do not broaden activation to trivial, irrelevant, repeated, sensitive, already-covered, or terminal-failure tasks.

**Independent Test**: All 15 frozen irrelevant prompts and every no-result/failure/repeat trace map to no adapter-directed search or a single final empty/failed attempt, with no query reformulation, second candidate, context escalation, or extra latency loop.

- [X] T082 [P] [US2] Add failing adapter non-trigger and bounded-failure tests in `tests/unit/evaluation/codex-adapter-package.test.ts` and `tests/unit/evaluation/activation-corpus.test.ts` for all frozen irrelevant prompts, ordinary work, local/already-loaded guidance, sensitive-only summaries, repeated intent, empty results, and every declared failure category (FR-003–005, FR-020–025, FR-045, FR-051; SC-003, SC-005, SC-008–009)
- [X] T083 [US2] Narrow `integrations/codex/skillwire-autonomous-activation/skills/autonomous-skill-activation/SKILL.md` and its front-loaded description as needed to make T082 pass without weakening specialized triggers, adding client state, or claiming enforcement that Codex/model traces must instead measure (depends on T082; FR-003–005, FR-020–025, FR-045; SC-003, SC-005, SC-014)

**Checkpoint — US2**: Adapter semantics preserve the one-attempt/no-result/fail-open boundary and do not create an “always search” skill.

---

## Phase 13: Adapter-Assisted User Story 3 — Preserve Invocation Isolation (Priority: P1)

**Goal**: Keep user-requested skills unavailable to autonomous discovery and permit that context only from explicit active-user intent.

**Independent Test**: Every frozen no-intent/explicit pair produces the expected context guidance and server filtering; relevance, tenant, and authorization rules remain unchanged; and failure recovery cannot escalate automatic context.

- [X] T084 [P] [US3] Add failing cross-surface isolation tests in `tests/unit/evaluation/codex-adapter-package.test.ts`, `tests/contract/mcp/search-skills.test.ts`, and `tests/evaluation/autonomous-activation.test.ts` for all ten frozen pairs, explicit-intent provenance, automatic default, no inferred escalation, and exact eligible revision only in user-requested context (FR-007, FR-009–012, FR-024, FR-045, FR-051; SC-004–005, SC-008–009)
- [X] T085 [US3] Refine only the adapter guidance in `integrations/codex/skillwire-autonomous-activation/skills/autonomous-skill-activation/SKILL.md` as needed to make T084 pass, preserving the server-enforced filtering boundary and never representing agent rationale as explicit user intent (depends on T084; FR-007, FR-009–012, FR-045; SC-004–005, SC-014)

**Checkpoint — US3**: Adapter and server surfaces agree on explicit-only user-requested context, with 100% deterministic pair isolation.

---

## Phase 14: Adapter-Assisted User Story 4 — Respect Equivalent Local Skills (Priority: P2)

**Goal**: Preserve local precedence and prevent adapter/plugin presence from being mistaken for a provenance-bearing remote SkillWire load.

**Independent Test**: The five predeclared overlap cases skip duplicate remote loading when sufficient local guidance exists, explicitly selected local guidance is never overridden, plugin/local guidance creates no SkillWire memory, and only an exact successful MCP load is attributed to SkillWire.

- [X] T086 [P] [US4] Add failing local-precedence semantic cases to `tests/unit/evaluation/codex-adapter-package.test.ts` and `tests/evaluation/autonomous-activation.test.ts` for the five frozen overlap fixtures, including equivalent, overlapping, and explicitly selected states with separately reported search/load expectations (FR-021–022, FR-028, FR-039, FR-045, FR-051; SC-007–009)
- [X] T087 [US4] Extend `tests/e2e/autonomous-activation-transport.test.ts` and `tests/integration/service/activation-memory-attribution.test.ts` to distinguish adapter skill inventory, local guidance, search previews, attempted loads, and successful exact provenance-bearing loads, asserting zero remote attribution/memory until the verified MCP load (depends on T086; FR-014, FR-017, FR-021–022, FR-053; SC-007, SC-009–010, SC-015)

**Checkpoint — US4**: Plugin/local inventory is never remote-load evidence, local precedence is explicit, and memory attribution remains server-controlled.

---

## Phase 15: Slices 7–8 / User Story 5 — Paired Evaluation and Claim Gate (Priority: P2)

**Goal**: Validate paired evidence deterministically, then run fresh matched server-only and server-plus-adapter cohorts with actual observable MCP traces while preserving the historical `0/7` artifact and keeping all model calls outside required CI.

**Independent Test**: The offline validator rejects unmatched experiments, privacy leaks, fabricated attribution, submitted-rate manipulation, and claims below any threshold. A fresh release-candidate pilot uses the immutable outcome-independent 15-case subset—8 clean automatic, 3 irrelevant, 2 explicit, and 2 paired no-intent cases—with identical non-plugin controls; counted successes contain actual search -> exact load traces; and `claimEligibility` is true only if every target passes. The result is explicitly non-definitive. The 30-case and 65-case pairs are optional, separately identified extended and expanded benchmarks.

### Paired evidence and attributable claim validation — tests before implementation

- [X] T088 [P] [US5] Extend `tests/unit/evaluation/manual-evidence.test.ts` with failing paired semantic cases for exact historical-baseline binding, immutable pilot binding, identical selected case IDs/prompt bytes/server controls, categorized clean inventories, plugin-only experimental difference, 8/3/2/2 strata, incomplete handling, trace attribution, and derived diagnostic codes (depends on T055–T056; FR-027A, FR-037–043, FR-053; SC-001–013, SC-015)
- [X] T089 [P] [US5] Extend `tests/contract/cli/activation-evidence.test.ts` with failing `validate-pair` and `summarize-pair` cases for stable safe JSON, external-reference/schema failures, nonzero exit status, no raw prompts/paths/credentials/content, and unchanged existing `validate`/`summarize` behavior (depends on T055; FR-040–043, FR-053; SC-010–013, SC-015)
- [X] T090 [US5] Implement paired-envelope Zod loading and structural/semantic comparison in `src/evaluation/activation-evidence.ts`, preserving the existing v1 validator while enforcing historical hash/path/result, exact release-subset identity/order, exact experiment controls, matching prompt bytes/configuration, categorized inventories, and only the adapter/plugin difference (depends on T088; FR-027A, FR-037, FR-040–043; SC-011–013)
- [X] T091 [US5] Extend `src/evaluation/activation-evidence.ts` to recompute both runs and derive `claimEligibility` only from per-case traces, requiring all selected 8 relevant cases, >=80% spontaneous automatic search, >=90% expected exact load after search, <=10% irrelevant activation across 3 cases, 100% isolation across 2 explicit/no-intent pairs, zero client writes, and attributable search -> exact load -> fixture-required resource ordering; adapter invocation or prose contributes zero successes and the result is qualified as non-definitive pilot evidence (depends on T090; FR-027A, FR-038–043, FR-053; SC-001–011, SC-015)
- [X] T092 [US5] Implement offline `validate-pair` and `summarize-pair` commands in `scripts/activation-evidence.ts`, emitting the recomputed eligibility/metrics/diagnostics without launching or configuring Codex, reading credentials, writing client trees, or entering required CI model execution (depends on T089–T091; FR-036–043, FR-053; SC-008, SC-010–013, SC-015)
- [X] T093 [US5] Update `package.json` and `.github/workflows/ci.yml` so required deterministic activation gates include T052–T092 package/marketplace/manager/evidence tests and every existing Feature 001/002 suite while making no model, live SkillWire, live GitHub, OAuth, or credential-dependent call (depends on T078, T081–T092; FR-031–036, FR-052; SC-008–009, SC-014–015)

### Fresh paired clean-profile cohorts — explicitly non-blocking in CI

- [X] T094 [US5] Revise the pre-run protocol in `docs/autonomous-activation-evaluation.md` to require the immutable outcome-independent 15-case 8/3/2/2 pilot, matched disposable mode-0700 `HOME`/`CODEX_HOME`, empty out-of-tree Git repositories, identical protected ephemeral authentication, no normal config/plugins/extra MCP/user/repository/admin skills, categorized effective inventories, new sessions, observer/server traces, 180-second one-attempt timeout, cleanup, and the historical candidate hash; label the 30-case pair as optional extended and 65-case pair as optional expanded evidence (depends on T092; FR-027A, FR-037–043, FR-053; SC-001–015)
- [X] T095 [US5] Execute the fresh server-instructions-only release-candidate pilot under T094 and retain privacy-safe temporary v1 evidence outside the repository until its matched adapter run completes; record the exact selected 8 relevant, 3 irrelevant, 2 explicit, and 2 paired no-intent cases, required resource cases, exact version controls, actual MCP traces, incompletes, zero writes, and cleanup without modifying `evaluation/evidence/003/candidate-v1.json`; previously completed observations may be reused only when their IDs are in the frozen pilot, and excluded observations remain separately disclosed (depends on T093–T094; FR-027A, FR-037–043; SC-003–006, SC-009–013)
- [X] T096 [US5] Install the exact T076/T077 adapter through the Codex manager in an otherwise identical fresh profile, execute the identical frozen 15-case server-plus-adapter pilot, and retain privacy-safe temporary v1 evidence for later embedding in `evaluation/evidence/003/adapter-pair-v1.json` with the same case IDs/prompts/server/auth/model/reasoning/evaluator controls, 180-second one-attempt rule, and actual observable operations; retain excluded completed observations as out-of-cohort evidence without reusing them (depends on T078, T095; FR-027A, FR-037–043, FR-044, FR-053; SC-001–006, SC-009–015)
- [X] T097 [US5] Compose and validate `evaluation/evidence/003/adapter-pair-v1.json` from T095/T096 only after both 15-case cohorts are complete, bind the immutable pilot and historical candidate path/hash, recompute all metrics and eligibility, reject fabricated/prose-only successes, qualify any passing result as non-definitive pilot/release-candidate evidence, and delete disposable profiles/repositories/credential copies/generated secrets; if blocked, leave the artifact absent and document the exact blocker instead of fabricating evidence (depends on T092, T095–T096; FR-027A, FR-037–043, FR-053; SC-001–006, SC-009–015)
- [X] T098 [US5] Execute the five local-overlap cases separately using only a version-recorded pre-existing controlled local inventory outside this repository and report them in `specs/003-autonomous-skill-activation/release-readiness.md`, with server-only and adapter conditions distinguished, zero SkillWire installation/modification of that inventory, and explicit search/load/override/attribution results outside the clean claim denominator (depends on T086–T087, T094; FR-021–022, FR-028, FR-038–043; SC-007, SC-009–011)
- [X] T099 [US5] Add the paired result and separate overlap result to `specs/003-autonomous-skill-activation/release-readiness.md`, preserving the historical `0/7` section verbatim in meaning and prohibiting any autonomous Codex claim unless `adapter-pair-v1.json` validates with `claimEligibility.eligible=true`; report sub-80%, external failure, or missing evidence honestly as non-blocking model evidence (depends on T097–T098; FR-038–043, FR-053; SC-001–015)

**Checkpoint — US5 / Slices 7–8**: Required CI remains deterministic. Historical `candidate-v1.json` is unchanged. The fresh pair is reproducible and attributable, and the release claim is mechanically blocked unless the adapter cohort meets every acceptance target.

---

## Phase 16: Slice 9 — Documentation and Full Release Readiness

**Purpose**: Replace server-only product claims with the advisory-baseline plus optional-plugin model, document the exact manager-owned lifecycle and failure boundaries, and run the complete release gate without touching Features 001 or 002.

**Independent Verification**: Operators can reproduce package validation, marketplace publication, install/verify/upgrade/rollback/uninstall, deterministic CI, and paired evaluation from documentation; the release record distinguishes deterministic success, historical negative evidence, and current model evidence; every regression and integrity gate passes; and scope audit finds no new MCP tool, schema change, migration, repository activation file, remote skill installation, UI, or direct Codex-directory write.

- [X] T100 [P] Update `README.md` with the falsified server-only hypothesis, portable advisory instructions, optional `skillwire-autonomous-activation@skillwire` plugin, exact no-content/no-credential boundary, manager lifecycle, explicit MCP operation without the plugin, and claim-gate language (FR-001, FR-006, FR-018, FR-043–053; SC-008–015)
- [X] T101 [P] Update `docs/operations.md` with dedicated marketplace promotion, two-step exact-SHA release, install/list/verify/upgrade/rollback/remove commands, equivalent/conflicting/missing dependency behavior, protected external authentication, safe failures, version compatibility, observability, and emergency uninstall (FR-023–026, FR-044–052; SC-008–009, SC-014)
- [X] T102 [P] Update `docs/privacy.md` with plugin/marketplace secret prohibitions, Codex-manager ownership, allowed three-file user-scope writes, zero repository/remote-skill-content writes, external credential preservation, inventory/evidence redaction, exact-load attribution, opaque-hash memory, and cleanup requirements (FR-006, FR-014, FR-017, FR-025, FR-041, FR-046–053; SC-009–011, SC-014–015)
- [X] T103 [P] Reconcile all runnable package, marketplace, lifecycle, deterministic-CI, paired-evidence, cleanup, and claim-gate commands in `specs/003-autonomous-skill-activation/quickstart.md` with the implemented paths and pinned versions, keeping model-dependent steps explicitly outside required CI (FR-031–043, FR-044–053; SC-001–015)
- [X] T104 Run Prettier, ESLint, strict typecheck, build, `test:activation`, `test:activation-adapter`, all unit/contract/PostgreSQL integration/E2E/evaluation/security suites, catalog integrity, advisory integrity, container-boundary checks, and `git diff --check`; record exact commands/counts/results and any honest non-blocking paired status in `specs/003-autonomous-skill-activation/release-readiness.md` (depends on T093, T099–T103; FR-023–026, FR-031–036, FR-052–053; SC-008–015)
- [X] T105 Audit the final tree and diff in `specs/003-autonomous-skill-activation/release-readiness.md` for exactly six backward-compatible MCP tools, zero migrations, zero changes under `specs/001-remote-skill-delivery/` and `specs/002-github-catalog-ingestion/`, zero root/client `.agents` or `.codex` activation files, zero UI/launcher code, zero installed remote skill content, zero direct application Codex writes, and only the contracted plugin/marketplace files (depends on T104; FR-018, FR-024–026, FR-044–052; SC-008–009, SC-014)
- [X] T106 Recompute and record the final hashes for `evaluation/autonomous-activation.v1.json`, `evaluation/evidence/003/candidate-v1.json`, all three plugin files, `distribution/codex-marketplace/release-integrity.json`, and the exact marketplace source commit in `specs/003-autonomous-skill-activation/release-readiness.md`; fail readiness on any frozen-byte drift, placeholder, stale integrity value, or unsupported activation claim (depends on T076–T077, T104–T105; FR-027–030, FR-043, FR-048–052; SC-008, SC-011, SC-013–015)

**Checkpoint — Slice 9**: Deterministic release gates and Feature 001/002 regressions are green, package/lifecycle integrity is reproducible, paired evidence is reported honestly and remains non-blocking in CI, and autonomous activation is claimed only when the validated adapter cohort reaches the contracted threshold.

---

## Dependencies and Execution Order

### Phase dependencies

1. **Phases 1–8 / T001–T051** are the audited completed advisory baseline. T046 is complete as historical negative evidence; it is not an acceptance success and is never rerun in place.
2. **Phase 9 / T052–T056** depends only on the completed baseline and blocks new adapter/evidence implementation by freezing hashes, advisory wording, source boundaries, and paired fixtures.
3. **Phase 10 / US6 / T057–T078** depends on Phase 9. Package tests precede the three files; marketplace/dependency tests precede validators; lifecycle tests use only the pinned manager and disposable profiles; T076/T077 additionally require an immutable plugin-source commit.
4. **Phase 11 / US1 / T079–T081** depends on the validated package in T062 and proves relevant-task adapter/server semantic conformance without a model claim.
5. **Phase 12 / US2 / T082–T083** depends on T080 because it narrows the same skill after the positive trigger contract is established.
6. **Phase 13 / US3 / T084–T085** depends on T083 and preserves explicit-only context in the same guidance file.
7. **Phase 14 / US4 / T086–T087** depends on T085 and the completed verified-load/memory baseline; it adds local/plugin/remote attribution separation.
8. **Phase 15 deterministic work / T088–T094** depends on the package, all story semantics, T055 paired fixtures, and the immutable outcome-independent 15-case stratified pilot. It must finish before any resumed model run.
9. **Phase 15 live work / T095–T099** depends on T094. It remains outside required CI. T097/T099 may report failed thresholds honestly, but no task may fabricate evidence or authorize a claim below the gate.
10. **Phase 16 / T100–T106** depends on all desired implementation work. Full release readiness requires exact source/integrity metadata; deterministic release gates do not require a model-success result.

### User-story dependency graph

```text
Completed advisory server baseline (T001-T051)
                    |
                    v
Reconciliation guards + paired fixtures (T052-T056)
                    |
                    v
US6 exact plugin -> marketplace/dependency -> manager lifecycle -> integrity
                    |
                    v
US1 relevant workflow -> US2 non-triggers -> US3 isolation -> US4 local precedence
                    |
                    v
US5 paired validator + deterministic CI
                    |
          +---------+---------+
          v                   v
fresh matched cohorts    documentation/full regressions
          |
          v
attributable metrics and claim gate (never a required-CI model gate)
```

### Within each phase

- Frozen or generated test fixtures precede consuming tests; tests precede their implementation.
- T059–T061 may proceed in parallel only after T057 defines their exact failing contract.
- T076/T077 cannot complete with placeholders or a Git SHA that does not contain the validated package.
- Exact search preview precedes load; verified exact load precedes resource or memory attribution.
- Deterministic package/server/evidence validation precedes T095/T096 model runs.
- T095 and T096 use the exact frozen 15-case order, matched controls, and fresh sessions; neither reuses or modifies the historical candidate. The 30-case pair is optional extended evidence and the full 65-case pair optional expanded evidence, each with a distinct identity.
- No failure task may add automatic retries, hidden task/session state, alternate revisions, custom installers, direct Codex-directory writes, or credential access.

## Parallel Opportunities

### Reconciliation

```text
Task T053: application/Codex-path security boundary tests
Task T054: advisory metadata and six-tool compatibility tests
```

### User Story 6 — Package and distribution

```text
Task T059: exact plugin manifest
Task T060: content-free activation SKILL.md
Task T061: Codex policy/MCP dependency metadata

Task T063: marketplace validator tests
Task T065: dependency/credential validator tests
Task T074: package integrity/reproducibility tests
```

The three package files are independent after T057. The three validator test fronts touch separate concerns and may be authored together before their shared validator implementation is completed.

### User Stories 1–4

```text
Task T079: relevant trigger/workflow contract
Task T082: irrelevant/non-trigger/failure contract
Task T084: explicit/no-intent isolation contract
Task T086: local-overlap contract
```

These tests can be designed from separate frozen cohorts, but changes to the shared `SKILL.md` must land sequentially as T080 -> T083 -> T085.

### User Story 5 — Paired validation

```text
Task T088: paired semantic and claim-gate tests
Task T089: paired CLI contract tests
```

T088 and T089 may be authored in parallel from T055. T095 and T096 are intentionally sequential to preserve matched setup and protected ephemeral credentials.

## Implementation Strategy

### First increment — lock the revised baseline

1. Complete T052–T056.
2. Re-run the focused advisory server and PostgreSQL attribution tests.
3. Verify the corpus and historical-candidate hashes.
4. Stop if any compatible baseline behavior regresses; do not modify Features 001 or 002 to repair it.

### MVP — installable, content-free adapter

1. Complete T057–T078 for US6.
2. Validate the exact three-file package and exact marketplace source identity.
3. Exercise Codex-managed install, verify, upgrade, rollback, and uninstall in disposable profiles.
4. Stop and validate zero credentials, zero repository writes, zero remote skill content, and zero application-owned Codex writes.
5. This is the smallest distributable adapter, not yet an autonomous-activation claim.

### Full incremental delivery

1. Complete US1–US4 semantic and attribution phases T079–T087.
2. Complete paired validation and deterministic CI through T094.
3. Run the fresh server-only and adapter cohorts T095–T098 outside required CI.
4. Derive claim eligibility and report it honestly in T099.
5. Complete documentation, full regressions, integrity, and scope audit T100–T106.
6. If the adapter cohort is below 80% or lacks attributable traces, ship no autonomous-activation claim; preserve the measured result and continue explicit/advisory operation.

## Notes

- T001–T051 are historical completed tasks. Their checkmarks do not imply server-only autonomous activation; T046 specifically records falsifying `0/7` evidence.
- Tests and evaluators may measure advisory harness behavior; production server code cannot force an arbitrary harness to invoke tools, detect local skills, or maintain task-intent state.
- `automatic` filtering, positive relevance, exact immutable loads, verified resources, authenticated tenant scope, and existing-row memory are server-enforceable and must remain covered independently.
- Use only synthetic fixture prompts and public immutable fixture identities. Never log or store raw task summaries, repository hashes, paths, contents, credentials, or unrelated conversation.
- The Codex adapter is exactly three content-free package files. Do not add `.mcp.json`, `.app.json`, scripts, hooks, assets, catalog entries, remote skill instructions/resources, uninstall code, custom installers, or credential fields.
- Marketplace catalog material may be generated inside disposable manager fixtures and published in the dedicated marketplace repository; never create root/client-repository `.agents/plugins`, `.codex`, `AGENTS.md`, local skill, or activation/configuration files here.
- SkillWire application code must never install, upgrade, remove, or write the plugin; only the Codex manager owns user-scope lifecycle state.
- Do not add MCP tools, operation-schema changes, database migrations, UI behavior, GitHub discovery, or live model/GitHub CI dependencies.
- Do not edit or reopen anything under `specs/001-*` or `specs/002-*`; compatibility is demonstrated by running their existing tests.
