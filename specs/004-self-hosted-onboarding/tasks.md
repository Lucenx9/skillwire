---

description: "Dependency-ordered implementation tasks for Feature 004"
---

# Tasks: Self-Hosted Onboarding and Native Client Integration

**Input**: Design documents from `/specs/004-self-hosted-onboarding/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Required by FR-086 through FR-092 and Constitution Principle VII. In every phase, write the listed tests first, run them, and confirm they fail for the missing behavior before beginning that phase's implementation tasks.

**Organization**: Tasks are grouped by the seven user stories. Each task names concrete files and an observable completion condition; no task modifies Feature 001-003 specifications or weakens their code, tests, packages, or invariants.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Safe to execute in parallel after prior phases complete because it touches different files and has no unfinished same-phase dependency.
- **[Story]**: Maps to the corresponding user story in `spec.md`; setup, foundational, and final release-gate tasks have no story label.

## Phase 1: Setup (Shared Test Infrastructure)

**Purpose**: Establish isolated fixtures and certified inputs without implementing application behavior.

- [x] T001 Create disposable HOME/XDG/empty-repository and named Docker-resource fixtures that reject real-profile/workspace targets in `tests/helpers/onboarding-environment.ts`
- [x] T002 [P] Record exact supported OS, architecture, Docker, Compose, PostgreSQL, Node, Codex, Claude, and Cosign fixture identities in `tests/fixtures/onboarding/supported-matrix.json`
- [x] T003 [P] Create bounded archive, canonical-manifest, Sigstore Bundle v0.3, TrustedRoot, and trust-policy fixture builders in `tests/helpers/self-hosted-release-fixtures.ts`
- [x] T004 [P] Create the isolated D-Bus/keyring session harness with explicit process/runtime teardown and persistent-XDG retention in `tests/helpers/secret-service-session.ts`
- [x] T005 [P] Create deterministic fake Codex, Claude, `secret-tool`, Cosign, Docker, and process-signal executables in `tests/helpers/onboarding-executables.ts`

---

## Phase 2: Foundational Safety and State (Blocking Prerequisites)

**Purpose**: Define test-first schemas and safe host primitives shared by every story.

**⚠️ CRITICAL**: No user-story implementation starts until this phase passes.

### Foundational tests — write and observe failure first

- [x] T006 [P] Add failing contract tests for external canonical manifest shape, archive binding, complete payload inventory, Feature 003 integrity identity, and Bundle v0.3 references in `tests/contract/release/release-manifest-schema.test.ts`
- [x] T007 [P] Add failing contract tests for `skillwire.trust-policy/v1`, signer claims, TrustedRoot/Cosign hashes, sequences, deny sets, validity, and overlap metadata in `tests/contract/release/trust-policy-schema.test.ts`
- [x] T008 [P] Add failing schema/state-transition tests for installation, installed release, service-secret set, ownership, external dependency, client integration, credential, snapshot, journal, backup, finding, verification, and source choice in `tests/unit/onboarding/domain-records.test.ts`
- [x] T009 [P] Add failing traversal, symlink, hard-link, owner/mode, no-follow open, exclusive-create, atomic-replace, file/directory-sync, and stale-identity tests in `tests/unit/onboarding/safe-filesystem.test.ts`
- [x] T010 [P] Add failing absolute-executable, `shell:false`, sanitized-environment, bounded-output, deadline, signal-cancellation, and redaction tests in `tests/unit/onboarding/command-runner.test.ts`
- [x] T011 [P] Add failing intent-before-effect, compensation, crash-boundary, PID/boot/start identity, stale-lock, and false-success tests in `tests/unit/onboarding/operation-journal.test.ts`
- [x] T012 [P] Add failing canonical preview, exact hash confirmation, JSON envelope, stable exit-class, and no-secret output tests in `tests/contract/cli/admin-envelope.test.ts`

### Foundational implementation

- [x] T013 [P] Implement the tested `skillwire.release/v1` schema in `distribution/self-hosted/release-manifest.schema.json`
- [x] T014 [P] Implement the tested trust-policy schema in `distribution/self-hosted/trust-policy.schema.json`
- [x] T015 Implement the first pinned canonical trust policy with exact GitHub issuer/repository/workflow/tag identity, TrustedRoot identity, Cosign 3.1.3 hashes, and sequence boundary in `distribution/self-hosted/trust-policy.v1.json`
- [x] T016 [P] Implement release manifest, trust policy, installed release, anti-downgrade, and compatibility records in `src/onboarding/domain/release-manifest.ts`
- [x] T017 [P] Implement installation, client integration, service-secret reference, backup, verification, and source-choice records/transitions in `src/onboarding/domain/installation.ts`
- [x] T018 [P] Implement exact owned-asset proofs and external-integration dependency classification in `src/onboarding/domain/ownership.ts`
- [x] T019 [P] Implement stable diagnostic codes, severity, bounded evidence, redacted summaries, and safe next-action records in `src/onboarding/domain/diagnostics.ts`
- [x] T020 [P] Implement validated XDG roots, containment, ownership/mode/link checks, and no-follow opens in `src/onboarding/adapters/filesystem/safe-paths.ts`
- [x] T021 Implement exclusive staging, file/directory sync, atomic JSON replacement, and semantic/file identity capture in `src/onboarding/adapters/filesystem/atomic-state.ts`
- [x] T022 [P] Implement direct-spawn process execution with absolute binaries, sanitized environments, bounded pipes, deadlines, and cancellation in `src/onboarding/adapters/process/command-runner.ts`
- [x] T023 [P] Implement recursive secret/error redaction and bounded human/JSON rendering in `src/onboarding/cli/output.ts`
- [x] T024 Implement durable operation journals and PID/boot/process-start installation locks in `src/onboarding/domain/operation-journal.ts`
- [x] T025 Implement canonical previews, preview-hash confirmation, shared exit classes, and validated administrative command types in `src/onboarding/cli/confirmation.ts`

**Checkpoint**: Release/state schemas and all host mutation primitives are test-backed.

---

## Phase 3: User Story 1 - Complete a Guided Local Installation (Priority: P1) 🎯 MVP

**Goal**: Verify a signed release, install a healthy loopback service, and optionally integrate either normal client or both with distinct keys and deterministic six-tool verification.

**Independent Test**: On disposable certified hosts, preview and confirm Codex-only, Claude-only, both, and neither; prove signed-release acceptance, restrictive stable service secrets, readiness, one account, distinct selected-client keys, exact native registrations, and the scripted six-tool journey.

### Tests for User Story 1 — write and observe failure first

- [x] T026 [P] [US1] Add failing compiled-entry dispatcher tests for one-pass argv parsing and every setup/status/doctor/client/repair/backup/upgrade/uninstall/purge/maintenance/bridge route in `tests/contract/cli/dispatcher.test.ts`
- [x] T027 [P] [US1] Add failing dispatcher tests for SIGINT/SIGTERM propagation, safe journal cancellation, stable process exit codes, JSON stdout purity, and human stderr separation in `tests/integration/onboarding/dispatcher-signals.test.ts`
- [x] T028 [P] [US1] Add failing bridge-routing tests proving MCP bytes bypass all administrative preview/progress/output and credentials never print in `tests/contract/cli/bridge-dispatch.test.ts`
- [x] T029 [P] [US1] Add failing tests for independent 256-bit generation, exclusive atomic creation, `0700`/`0600`, link/owner/mode rejection, byte-for-byte reuse, no automatic rotation, and redaction in `tests/unit/onboarding/service-secrets.test.ts`
- [x] T030 [P] [US1] Add failing production-Compose tests proving service-secret file mounts, readiness, zero environment/config/log disclosure, and independent database/application values in `tests/integration/onboarding/service-secrets-compose.test.ts`
- [x] T031 [P] [US1] Add failing external-manifest canonicalization, archive-path/inventory, image/Compose/catalog/advisory/migration/adapter, and Feature 003 integrity contract tests in `tests/contract/release/self-hosted-release.test.ts`
- [x] T032 [P] [US1] Add failing protected-tag workflow tests for pinned verified Cosign 3.1.3, exact OIDC permissions/issuer/identity/claims, and `sign-blob --bundle` in `tests/contract/release/signing-workflow.test.ts`
- [x] T033 [P] [US1] Add failing offline verification tests for Bundle v0.3, local TrustedRoot, invalid signature/transparency/identity/digest/policy, sequence downgrade, deny set, overlap rotation, emergency revocation, and lost-signer recovery in `tests/security/onboarding/trust-policy-lifecycle.test.ts`
- [x] T034 [P] [US1] Add failing service-only setup tests for prerequisites, local Docker context, occupied ports, immutable install, migration gate, liveness/readiness, stable volume/account, and no-client mode in `tests/integration/onboarding/service-setup.test.ts`
- [x] T035 [P] [US1] Add failing fake-helper tests for Secret Service stdin/stdout isolation and explicitly confirmed restrictive-file permission/link behavior in `tests/unit/onboarding/credential-backends.test.ts`
- [x] T036 [P] [US1] Add failing real `/usr/bin/secret-tool` tests for available, locked, unavailable, clear, fresh-process, destroyed/recreated session, and retained-XDG behavior in `tests/integration/onboarding/secret-service-session.test.ts`
- [x] T037 [P] [US1] Add failing real MCP client tests for STDIO-to-loopback-HTTP initialization, exact instructions/six tools/schemas/annotations/results/errors, and cancellation in `tests/contract/credential-bridge/stdio-http-bridge.test.ts`
- [x] T038 [P] [US1] Add failing monotonic end-to-end tests proving process start through credential lookup/upstream validation/STDIO readiness or failure finishes within 10.0 seconds in `tests/contract/credential-bridge/end-to-end-deadline.test.ts`
- [x] T039 [P] [US1] Add failing canary tests proving one-shot account/key handoff avoids argv, environment, stdout/stderr, terminal, `/proc`, and Docker logs in `tests/security/onboarding/private-key-channel.test.ts`
- [x] T040 [P] [US1] Add failing clean-profile Codex 0.147.0 manager tests for absent-name add, optional MCP, plugin lifecycle, and real effective registration readback in `tests/contract/clients/codex-onboarding.test.ts`
- [x] T041 [P] [US1] Add failing clean-profile Claude Code 2.1.229 tests for explicit user-scope MCP/plugin lifecycle and real effective registration readback in `tests/contract/clients/claude-onboarding.test.ts`
- [x] T042 [P] [US1] Add failing Codex-only, Claude-only, both, neither, and independently compensated client-failure journeys in `tests/e2e/self-hosted-onboarding/setup-matrix.test.ts`
- [x] T043 [P] [US1] Add failing fresh-process deterministic six-tool/search/exact-load/provenance/advisory tests and separate non-gating automatic-activation evidence in `tests/e2e/self-hosted-onboarding/client-verification.test.ts`

### Implementation for User Story 1

- [x] T044 [US1] Implement the sole database/application secret lifecycle boundary and pass T029-T030 in `src/onboarding/secrets/service-secrets.ts`
- [x] T045 [P] [US1] Implement reproducible per-architecture archive assembly and RFC 8785 external release-manifest generation with no BOM/trailing newline in `scripts/build-self-hosted-release.ts`
- [x] T046 [P] [US1] Implement pinned Cosign 3.1.3 keyless manifest signing and signer-overlap bundle generation in `scripts/sign-self-hosted-release.ts`
- [x] T047 [US1] Implement the protected exact-tag release workflow with verified Cosign acquisition, minimal permissions, build/test-before-sign, and publication failure gates in `.github/workflows/self-hosted-release.yml`
- [x] T048 [P] [US1] Implement local TrustedRoot, exact signer-claim, Bundle v0.3, policy rotation/revocation, sequence, canonical manifest, archive, and payload verification in `src/onboarding/adapters/filesystem/release-verifier.ts`
- [x] T049 [US1] Implement independent bootstrap/candidate verification with network-blocked Cosign and full release identity checks in `scripts/verify-self-hosted-release.ts`
- [x] T050 [P] [US1] Implement the no-build, digest-pinned, loopback-only, non-root topology with unpublished PostgreSQL and restrictive service-secret files in `distribution/self-hosted/compose.yaml`
- [x] T051 [P] [US1] Implement supported-host probing, local-context enforcement, image inspection, Compose lifecycle, bounded liveness/readiness, and cancellation in `src/onboarding/adapters/docker/deployment.ts`
- [x] T052 [P] [US1] Implement stable database-volume discovery, live migration/checksum/010 compatibility, and readiness probes in `src/onboarding/adapters/postgres/service-database.ts`
- [x] T053 [US1] Implement safe extraction, immutable release installation, active selection, stable launcher installation, trust-sequence persistence, and ownership records in `src/onboarding/adapters/filesystem/release-installer.ts`
- [x] T054 [US1] Implement the sole one-pass executable dispatcher with bridge-first routing, signals, cancellation, output isolation, and exit mapping in `src/onboarding/cli/main.ts`
- [x] T055 [US1] Implement every documented administrative dispatch route and final machine/human envelope in `src/onboarding/cli/command-router.ts`
- [x] T056 [US1] Wire `src/onboarding/cli/main.ts` as the package `skillwire` executable and distributed `bin/skillwire` entry with no wrapper client/profile behavior in `package.json`
- [x] T057 [P] [US1] Extend key creation with a validated private FIFO/file-descriptor output mode and non-secret stdout metadata in `src/authentication/admin-cli.ts`
- [x] T058 [US1] Implement the no-log one-shot administration container and bounded private key handoff in `src/onboarding/adapters/postgres/bootstrap-admin.ts`
- [x] T059 [P] [US1] Implement trusted `/usr/bin/secret-tool` probe/store/lookup/clear with per-installation/client attributes and bounded failure classes in `src/onboarding/adapters/credentials/secret-tool.ts`
- [x] T060 [P] [US1] Implement separately confirmed client-specific fallback credential creation/read/removal with exact no-follow `0600` invariants in `src/onboarding/adapters/credentials/restrictive-file.ts`
- [x] T061 [US1] Implement per-client credential persistence/reference verification, compensation, and newly created key revocation in `src/onboarding/application/client-credentials.ts`
- [x] T062 [P] [US1] Implement owned installation-state and one-time client credential resolution in `src/credential-bridge/credential-resolver.ts`
- [x] T063 [P] [US1] Implement authenticated no-redirect loopback HTTP initialization, exact six-tool validation, internal deadline budgets, and one attempt in `src/credential-bridge/upstream-client.ts`
- [x] T064 [US1] Implement transparent MCP STDIO exposure and bounded call/result/error forwarding in `src/credential-bridge/stdio-server.ts`
- [x] T065 [US1] Implement strict bridge arguments, lifecycle, cancellation, deadline, redacted exit findings, and cleanup in `src/credential-bridge/bridge-cli.ts`
- [x] T066 [P] [US1] Version the unchanged Feature 003 three-file Codex package and update both marketplace identity and `distribution/codex-marketplace/release-integrity.json` in `integrations/codex/skillwire-autonomous-activation/.codex-plugin/plugin.json`, `distribution/codex-marketplace/marketplace.json`, and `distribution/codex-marketplace/release-integrity.json`
- [x] T067 [P] [US1] Create the instruction-only Claude activation package and release-local marketplace in `integrations/claude/skillwire-autonomous-activation/.claude-plugin/plugin.json`, `integrations/claude/skillwire-autonomous-activation/skills/autonomous-skill-activation/SKILL.md`, and `distribution/claude-marketplace/.claude-plugin/marketplace.json`
- [x] T068 [P] [US1] Implement certified Codex absent-name preflight, user MCP add, marketplace/plugin lifecycle, readback, and narrow inverse commands in `src/onboarding/adapters/clients/codex.ts`
- [x] T069 [P] [US1] Implement certified Claude explicit-user-scope preflight, MCP add, marketplace/plugin lifecycle, readback, and narrow inverse commands in `src/onboarding/adapters/clients/claude.ts`
- [x] T070 [US1] Implement fresh normal-profile inventory, exact bridge registration, six-tool smoke journey, provenance/advisory, and post-inventory verification in `src/onboarding/application/client-verification.ts`
- [x] T071 [P] [US1] Implement separate privacy-safe automatic-activation evidence that cannot change deterministic installation state in `src/onboarding/application/activation-diagnostic.ts`
- [x] T072 [US1] Implement signed-release service setup plus independent selected-client transactions for all four selection modes in `src/onboarding/application/setup.ts`
- [x] T073 [US1] Implement clean-profile client install/verify compensation and connect it to the setup routes in `src/onboarding/application/client-lifecycle.ts`

**Checkpoint**: The signed-release MVP works through one real executable for no client, either client, or both.

---

## Phase 4: User Story 2 - Preserve Existing Client Profiles (Priority: P1)

**Goal**: Reconcile populated normal profiles without overwriting conflicts, duplicating entries, claiming external equivalents, or touching repository state.

**Independent Test**: Seed unrelated state, equivalent external components, same-name conflicts, alternate-name ambiguity, managed policy, and concurrent edits; verify exact preservation, client-local blocking, partial dual-client success, and zero automatic conflict mutation.

### Tests for User Story 2 — write and observe failure first

- [ ] T074 [P] [US2] Add populated-profile, unrelated-state, managed-policy, duplicate, shadow, conflict, alternate-name, concurrent-edit, and repository canary fixtures in `tests/helpers/client-profile-fixtures.ts`
- [ ] T075 [P] [US2] Add failing Codex comment/byte preservation, same-name add prevention, real MCP readback, and plugin-dependency isolation tests in `tests/contract/clients/codex-profile-preservation.test.ts`
- [ ] T076 [P] [US2] Add failing Claude semantic preservation, explicit user scope, managed/shadowed state, and unrelated-inventory tests in `tests/contract/clients/claude-profile-preservation.test.ts`
- [ ] T077 [P] [US2] Add failing equivalent external integration tests proving setup/repair/upgrade/uninstall/purge create zero duplicates and perform zero mutation in `tests/e2e/self-hosted-onboarding/external-integration-reuse.test.ts`
- [ ] T078 [P] [US2] Add failing non-equivalent/ambiguous conflict tests proving exact redacted external-resolution output, affected-client-only blocking, no adopt/rename/overwrite/disable/remove, and retained successful sibling client/service in `tests/e2e/self-hosted-onboarding/client-conflict-partial-success.test.ts`
- [ ] T079 [P] [US2] Add failing stale-snapshot, arbitrary unrelated profile preservation, and zero repository client-file write tests in `tests/e2e/self-hosted-onboarding/profile-safety.test.ts`

### Implementation for User Story 2

- [ ] T080 [P] [US2] Implement protected profile snapshots, before/expected-post identities, and concurrency-safe restore eligibility in `src/onboarding/domain/profile-snapshot.ts`
- [ ] T081 [P] [US2] Implement absent/owned-equivalent/external-equivalent/conflict/ambiguous/duplicate/shadowed/managed/drifted classification in `src/onboarding/adapters/clients/client-state.ts`
- [ ] T082 [P] [US2] Add Codex effective-scope inventory, same-name preflight, preservation checks, external reuse, and exact conflict reporting in `src/onboarding/adapters/clients/codex.ts`
- [ ] T083 [P] [US2] Add Claude precedence/managed inventory, preservation checks, external reuse, and exact conflict reporting in `src/onboarding/adapters/clients/claude.ts`
- [ ] T084 [US2] Implement narrow vendor mutation, post-image proof, safe inverse, and stale-snapshot refusal in `src/onboarding/application/profile-transaction.ts`
- [ ] T085 [US2] Persist only proven created assets and record equivalent pre-existing components solely as untouched external dependencies in `src/onboarding/domain/ownership.ts`
- [ ] T086 [US2] Apply external/conflict rules across setup, repair, upgrade, verification, client removal, uninstall, and purge in `src/onboarding/application/client-lifecycle.ts`
- [ ] T087 [US2] Preserve healthy service/sibling-client commits and emit the documented incomplete result when one selected client is blocked or compensated in `src/onboarding/application/setup.ts`

**Checkpoint**: Existing profiles and external integrations remain user-owned and unchanged; conflicts never trigger destructive reconciliation.

---

## Phase 5: User Story 3 - Keep Normal Clients Usable During SkillWire Failure (Priority: P1)

**Goal**: Keep ordinary Codex and Claude usable through one bounded SkillWire attempt when credentials, service, authentication, protocol, or contracts fail.

**Independent Test**: Inject every documented bridge/service failure and prove ordinary clients start, unrelated work succeeds, the bridge finishes within 10 seconds without retry/prompt, and automatic diagnostics remain separate.

### Tests for User Story 3 — write and observe failure first

- [ ] T088 [P] [US3] Add failing stable bridge-code, safe stderr/MCP error, prompt-free, cancellation, and post-initialization close tests in `tests/contract/credential-bridge/failure-contract.test.ts`
- [ ] T089 [P] [US3] Add failing ordinary Codex/Claude stopped/unreachable/401/missing/locked/timeout/incompatible/tool-mismatch startup tests in `tests/e2e/self-hosted-onboarding/fail-open-clients.test.ts`
- [ ] T090 [P] [US3] Add failing one-attempt/no-reconnect/no-retry/no-auth-prompt traces within the 10-second budget in `tests/security/onboarding/bounded-activation.test.ts`
- [ ] T091 [P] [US3] Add failing explicit user-requested search/exact-load tests with unchanged eligibility/provenance bounds and separate evidence in `tests/e2e/self-hosted-onboarding/explicit-skillwire-request.test.ts`

### Implementation for User Story 3

- [ ] T092 [P] [US3] Implement stable redacted bridge error mapping for state, endpoint, credential, auth, contract, timeout, cancellation, and transport failures in `src/credential-bridge/bridge-errors.ts`
- [ ] T093 [US3] Enforce one upstream attempt, total deadline budgeting, safe post-initialization closure, and zero reconnect in `src/credential-bridge/upstream-client.ts`
- [ ] T094 [P] [US3] Enforce optional Codex registration without `required=true`, static headers, or secret env forwarding in `src/onboarding/adapters/clients/codex.ts`
- [ ] T095 [P] [US3] Enforce optional Claude connection behavior and bounded no-retry activation guidance in `src/onboarding/adapters/clients/claude.ts` and `integrations/claude/skillwire-autonomous-activation/skills/autonomous-skill-activation/SKILL.md`
- [ ] T096 [US3] Keep deterministic failures distinct from automatic `not-invoked` evidence and retain deterministically verified integrations in `src/onboarding/application/client-verification.ts`

**Checkpoint**: SkillWire remains optional augmentation and cannot prevent normal client startup.

---

## Phase 6: User Story 4 - Operate, Diagnose, and Repair Idempotently (Priority: P2)

**Goal**: Deliver truthful inspection, complete safe diagnostics, unchanged-setup no-op behavior, interruption recovery, and explicit client/service secret rotations.

**Independent Test**: Repeat setup ten times, inject all diagnostic/journal/lock/repair cases, rotate each secret only through its explicit workflow, and prove exact recovery, no false completion, no implicit rotation, and zero disclosure.

### Tests for User Story 4 — write and observe failure first

- [ ] T097 [P] [US4] Add failing `status`, `doctor`, `repair`, `clients rotate-key`, and `maintenance rotate-service-secret` JSON/exit/output tests in `tests/contract/cli/lifecycle-operations.test.ts`
- [ ] T098 [P] [US4] Add failing FR-061 fixture classification plus release/trust/service-secret/dispatcher/ownership/concurrency/backup/recovery findings in `tests/integration/onboarding/doctor-classification.test.ts`
- [ ] T099 [P] [US4] Add failing ten-run account/key/volume/service-secret/source/plugin/MCP identity and zero unchanged-write tests in `tests/e2e/self-hosted-onboarding/repeated-setup.test.ts`
- [ ] T100 [P] [US4] Add failing drifted-owned, ambiguous, external, data-preserving, and no-implicit-secret-rotation repair tests in `tests/integration/onboarding/repair.test.ts`
- [ ] T101 [P] [US4] Add failing process termination after every journal intent/effect/verify/compensate/commit boundary in `tests/integration/onboarding/interruption-recovery.test.ts`
- [ ] T102 [P] [US4] Add failing live-lock, proven-stale-lock, and exactly-one-mutator tests in `tests/integration/onboarding/concurrent-mutator.test.ts`
- [ ] T103 [P] [US4] Add failing replacement client-key verification, old-key retention on failure, and sibling-key isolation tests in `tests/security/onboarding/key-rotation.test.ts`
- [ ] T104 [P] [US4] Add failing database/application rotation tests for explicit preview, independent new value, retained old file, readiness commit, rollback at every boundary, and zero disclosure in `tests/integration/onboarding/service-secret-rotation.test.ts`

### Implementation for User Story 4

- [ ] T105 [P] [US4] Implement bounded installed/live state inspection without credential retrieval or mutation in `src/onboarding/application/status.ts`
- [ ] T106 [P] [US4] Implement layered release/trust/filesystem/Docker/PostgreSQL/migration/catalog/service-secret/credential/bridge/client/source/backup/journal probes in `src/onboarding/application/diagnostic-probes.ts`
- [ ] T107 [US4] Aggregate stable redacted findings and exact safe next actions for `doctor` in `src/onboarding/application/doctor.ts`
- [ ] T108 [US4] Implement observation-based journal recovery and narrow compensation at the last validated boundary in `src/onboarding/application/recovery.ts`
- [ ] T109 [US4] Implement preview-first, ownership-proven, data-preserving repair with no implicit key/service-secret rotation in `src/onboarding/application/repair.ts`
- [ ] T110 [US4] Implement persist-and-verify-before-revoke client-key rotation in `src/onboarding/application/client-credentials.ts`
- [ ] T111 [US4] Implement explicit database/application secret rotation with old-value retention, readiness, commit, and application/config rollback in `src/onboarding/application/service-secret-rotation.ts`
- [ ] T112 [US4] Make unchanged setup a byte-for-byte no-op across secrets, state, clients, sources, catalog, volume, and account in `src/onboarding/application/setup.ts`
- [ ] T113 [US4] Wire status/doctor/repair/client-key/service-secret maintenance routes and final summaries in `src/onboarding/cli/command-router.ts`

**Checkpoint**: Operations are idempotent and recoverable; rotation is always explicit and narrowly reversible.

---

## Phase 7: User Story 5 - Upgrade Across Safe and Forward-Only Boundaries (Priority: P2)

**Goal**: Produce restore-validated backups and perform compatible or migration-010 upgrades without release/trust downgrade or unsafe rollback.

**Independent Test**: Upgrade populated installations across both schema cases; inject release/trust, backup, drain, migration, readiness, and client failures and prove preserved state, compatible rollback, and exact restore-required behavior.

### Tests for User Story 5 — write and observe failure first

- [ ] T114 [P] [US5] Add failing custom-format dump, checksum, isolated restore/readiness, invalid archive, service-secret-reference-only, and no-raw-secret tests in `tests/integration/onboarding/backup-restore-validation.test.ts`
- [ ] T115 [P] [US5] Add failing no-schema-change upgrade and automatic application/config rollback tests in `tests/integration/onboarding/upgrade-compatible.test.ts`
- [ ] T116 [P] [US5] Add failing migration-010 drain, validated-backup-before-migration, live-schema readback, and unsafe pre-010 rollback refusal tests in `tests/integration/onboarding/upgrade-forward-only-010.test.ts`
- [ ] T117 [P] [US5] Add failing interruption injection for release verification, backup, drain, migration, readiness, clients, and release commit in `tests/integration/onboarding/upgrade-interruption.test.ts`
- [ ] T118 [P] [US5] Add failing repository-memory, client/service-secret, ownership, volume, backup, source, and unrelated-profile preservation tests in `tests/e2e/self-hosted-onboarding/upgrade-preservation.test.ts`
- [ ] T119 [P] [US5] Add failing upgrade rejection tests for lower release/policy sequence, stale policy, bad overlap, denied signer/material, and incompatible restored executable trust in `tests/security/onboarding/upgrade-trust-downgrade.test.ts`

### Implementation for User Story 5

- [ ] T120 [P] [US5] Implement `pg_dump -Fc`, isolated PostgreSQL 17.10 restore, safe `pg_restore`, checksums, invariants, readiness, and validation cleanup in `src/onboarding/adapters/postgres/backup.ts`
- [ ] T121 [US5] Implement protected backup-set state and recovery manifests containing only non-secret service/client credential references in `src/onboarding/application/backup.ts`
- [ ] T122 [P] [US5] Implement manifest/live-schema compatibility and forward-only rollback decisions in `src/onboarding/adapters/postgres/schema-compatibility.ts`
- [ ] T123 [P] [US5] Implement application, ingestion, and administration writer draining/restart controls in `src/onboarding/adapters/docker/writer-drain.ts`
- [ ] T124 [US5] Implement target trust/release verification, anti-downgrade, backup, confirmation, migration, readiness, client verification, and active-policy/release commit in `src/onboarding/application/upgrade.ts`
- [ ] T125 [US5] Implement compatible application/config rollback and restore-required guidance with backup identity, release, data-loss boundary, and erased-memory warning in `src/onboarding/application/upgrade-recovery.ts`
- [ ] T126 [US5] Integrate upgrade journal boundaries and atomic active release/trust-policy selection in `src/onboarding/adapters/filesystem/release-installer.ts`
- [ ] T127 [US5] Wire `backup` and `upgrade --release` previews, exit classes, backup IDs, rollback boundaries, and recovery summaries in `src/onboarding/cli/command-router.ts`

**Checkpoint**: Upgrades are signed, restore-backed, schema-aware, anti-downgrade, and interruption-safe.

---

## Phase 8: User Story 6 - Uninstall Selectively and Preserve Data by Default (Priority: P2)

**Goal**: Remove only proven owned integration/service state, retain recovery data by default, and isolate permanent deletion behind exact confirmation.

**Independent Test**: Default-uninstall a populated installation, reinstall without duplicates, then purge exact confirmed owned assets while external, ambiguous, drifted, concurrent, and unrelated state remains untouched.

### Tests for User Story 6 — write and observe failure first

- [ ] T128 [P] [US6] Add failing owned-only client removal, container stop, retained volume/backups/client and service secrets/releases/trust/ownership, and unrelated-state tests in `tests/e2e/self-hosted-onboarding/default-uninstall.test.ts`
- [ ] T129 [P] [US6] Add failing retained installation/data/secret reuse and duplicate-free account/key/MCP/plugin reinstall tests in `tests/e2e/self-hosted-onboarding/reinstall-retained-data.test.ts`
- [ ] T130 [P] [US6] Add failing separate purge preview/hash/installation-ID confirmation and exact named deletion tests in `tests/e2e/self-hosted-onboarding/permanent-removal.test.ts`
- [ ] T131 [P] [US6] Add failing external/ambiguous/drifted/concurrent/symlinked/interrupted removal tests proving zero mutation outside current ownership in `tests/security/onboarding/removal-boundaries.test.ts`

### Implementation for User Story 6

- [ ] T132 [US6] Implement matching-owned-only Codex/Claude MCP/plugin/marketplace/credential/key inverse operations in `src/onboarding/application/client-lifecycle.ts`
- [ ] T133 [US6] Implement data/service-secret/trust/release-preserving default uninstall and retained-state transitions in `src/onboarding/application/uninstall.ts`
- [ ] T134 [P] [US6] Implement exact owned-asset purge planning, separate confirmation scope, safe deletion, and unrecoverable inventory in `src/onboarding/application/purge.ts`
- [ ] T135 [US6] Enforce retain-by-default/remove-only-on-purge dispositions and current identity proof in `src/onboarding/domain/ownership.ts`
- [ ] T136 [US6] Implement interrupted uninstall convergence and ambiguity-safe recovery in `src/onboarding/application/recovery.ts`
- [ ] T137 [US6] Wire `clients uninstall`, `uninstall`, and `purge` previews, confirmations, and stable results in `src/onboarding/cli/command-router.ts`
- [ ] T138 [US6] Add retained installation discovery and duplicate-free reactivation to `src/onboarding/application/setup.ts`

**Checkpoint**: Default removal is reversible; purge cannot reuse uninstall confirmation or delete external/ambiguous state.

---

## Phase 9: User Story 7 - Start with a Trustworthy Catalog (Priority: P3)

**Goal**: Serve the ten immutable first-party skills without GitHub and offer curated sources only as explicit separately credentialed choices through existing quarantine paths.

**Independent Test**: Block GitHub for fresh setup and prove the ten-skill smoke journey, then test each opt-in source and degraded sync without executing/importing client content or affecting ready cached content.

### Tests for User Story 7 — write and observe failure first

- [ ] T139 [P] [US7] Add failing no-GitHub/no-token first-party setup, exact ten-skill identity, advisory, and smoke tests in `tests/e2e/self-hosted-onboarding/first-party-catalog.test.ts`
- [ ] T140 [P] [US7] Add failing unselected/selected `mattpocock/skills` and `obra/superpowers` registration/quarantine tests in `tests/integration/onboarding/source-bootstrap.test.ts`
- [ ] T141 [P] [US7] Add failing rate-limit, unavailable, revoked, quarantined, and integrity-failure degraded-source tests in `tests/integration/onboarding/source-degradation.test.ts`
- [ ] T142 [P] [US7] Add failing imported-text non-execution, zero client/repository installation, and separate GitHub/client credential tests in `tests/security/onboarding/source-boundaries.test.ts`

### Implementation for User Story 7

- [ ] T143 [P] [US7] Implement explicit bootstrap-source choice and sync-state validation in `src/onboarding/domain/source-choice.ts`
- [ ] T144 [P] [US7] Implement bundled ten-skill catalog/advisory identity verification with GitHub disabled in `src/onboarding/application/first-party-catalog.ts`
- [ ] T145 [P] [US7] Implement separate read-only GitHub credential persistence/reference handling in `src/onboarding/adapters/credentials/github-token.ts`
- [ ] T146 [US7] Orchestrate fixed-origin registration and the existing ingestion/quarantine pipeline without changing first-party readiness in `src/onboarding/application/source-bootstrap.ts`
- [ ] T147 [US7] Add explicit source previews/options and post-readiness bootstrap in `src/onboarding/application/setup.ts`
- [ ] T148 [US7] Emit bounded degraded-source findings while preserving eligible cached content in `src/onboarding/application/diagnostic-probes.ts`

**Checkpoint**: Baseline catalog use is offline; optional imported content remains explicit, inert, provenance-bound, and isolated.

---

## Phase 10: Cross-Cutting Release Gates and Documentation

**Purpose**: Close full acceptance, security, integrity, evidence, compatibility, documentation, and matrix requirements before publication.

### Release-gate tests — add before their implementation/evidence tasks

- [ ] T149 [P] Add failing canary/no-telemetry scans across argv, environment, `/proc`, logs, terminal captures, configs, diffs, snapshots, journals, backups, reports, release artifacts, and repository files in `tests/security/onboarding/secret-containment.test.ts`
- [ ] T150 [P] Add a failing table-driven traceability suite mapping all 28 numbered scenarios, FR-001 through FR-092, and buildable SC gates to concrete evidence in `tests/e2e/self-hosted-onboarding/acceptance-scenarios.test.ts`
- [ ] T151 [P] Add failing archive extraction, canonicalization, signature/transparency/claim, overlap/revocation/downgrade, unlisted-byte, mutable-image, unsafe-Compose, and matrix-overclaim tests in `tests/security/onboarding/release-integrity.test.ts`
- [ ] T152 [P] Add failing compatibility tests that recompute and validate the unchanged Feature 003 Codex package inventory and `distribution/codex-marketplace/release-integrity.json` in `tests/contract/release/feature-003-integrity-compatibility.test.ts`
- [ ] T153 [P] Add a non-gating clean-host setup-duration recorder that reports elapsed time without treating the 15-minute participant target as a CI threshold in `tests/e2e/self-hosted-onboarding/setup-duration-evidence.test.ts`

### Release-gate implementation and evidence

- [ ] T154 Refresh candidate verification to enforce T151-T152 and refuse publication on any Feature 001-003 integrity/regression failure in `scripts/verify-self-hosted-release.ts`
- [ ] T155 Add the aggregate Feature 004 test command while retaining all existing Feature 001-003 commands unchanged in `package.json`
- [ ] T156 Write exact Cosign bootstrap verification, four normal sibling assets, overlap-bundle exception, offline `verify-blob`, trust refresh/rotation/revocation, extraction, and no-`curl | sh` instructions in `distribution/self-hosted/README.md`
- [ ] T157 [P] Document setup/status/doctor/repair/backup/upgrade/uninstall/purge, credential/service-secret lifecycle, no-wrapper profiles, privacy, and support boundaries in `README.md`, `docs/operations.md`, and `docs/privacy.md`
- [ ] T158 [P] Define exact release evidence, certified matrix, automatic-activation claim separation, informational setup duration, and moderated usability result format in `docs/self-hosted-release-evidence.md`
- [ ] T159 Implement Ubuntu 24.04 and Debian 12/13 `amd64`/`arm64`, rootless/rootful, pinned-client, real Secret Service, backup/upgrade, 28-scenario, and Feature 001-003 release jobs in `.github/workflows/ci.yml` and `.github/workflows/self-hosted-release.yml`
- [ ] T160 Implement the disposable-profile quickstart runner with exact signed-asset verification and safe named-resource cleanup in `scripts/validate-self-hosted-quickstart.ts`
- [ ] T161 Run Prettier, diff-check, lint, typecheck, build, all test projects, unchanged Feature 001-003 regressions, Feature 004 aggregate, quickstart, and supported matrix; record exact outcomes in `docs/self-hosted-release-evidence.md`

**Checkpoint**: Publication is blocked until all 28 scenarios, signing/trust gates, disclosure scans, profile preservation, and unchanged Feature 001-003 invariants pass.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 — Setup**: Starts immediately; its isolated fixtures must complete before test phases use them.
- **Phase 2 — Foundational**: Depends on Phase 1 and blocks every user story. T006-T012 are written/run before T013-T025.
- **Phase 3 — US1/MVP**: Depends on Phase 2. T026-T043 are written/run before T044-T073.
- **Phase 4 — US2**: Depends on US1's base client lifecycle. T074-T079 precede T080-T087.
- **Phase 5 — US3**: Depends on US1 and may proceed in parallel with US2; T088-T091 precede T092-T096.
- **Phase 6 — US4**: Depends on US1 and US2 ownership/reconciliation. T097-T104 precede T105-T113.
- **Phase 7 — US5**: Depends on US2 and US4 journals/recovery. T114-T119 precede T120-T127.
- **Phase 8 — US6**: Depends on US2 and US4; it may proceed in parallel with US5. T128-T131 precede T132-T138.
- **Phase 9 — US7**: Depends only on US1 and may proceed alongside US2-US6. T139-T142 precede T143-T148.
- **Phase 10 — Release gates**: Depends on all seven stories. T149-T153 precede T154-T161.

### User-story dependency graph

```text
Setup -> Foundation -> US1 (MVP)
                         ├──> US2 ──> US4 ──> US5
                         │              └────> US6
                         ├──> US3
                         └──> US7

US3 + US5 + US6 + US7 -> Cross-cutting release gates
```

### Within every story

1. Complete all listed test tasks and observe the expected failures.
2. Implement independent domain/adapters after their tests; `[P]` tasks touch disjoint files.
3. Implement orchestration and CLI wiring only after dependencies pass.
4. Run the story's independent test and prior-story regressions at the checkpoint.
5. Require actual process, manager/profile, MCP, Docker, PostgreSQL, filesystem, and Sigstore evidence wherever the contract names those boundaries; mocked inventory or final prose is insufficient.

---

## Parallel Execution Examples

### User Story 1

After T026-T043 fail as expected, run the release track T045-T050, service track T044/T051-T053, credential track T057-T062, and client-package track T066-T069 in parallel. Converge on bridge T063-T065, verification T070-T071, and setup T072-T073.

### User Story 2

Run Codex T075/T082 and Claude T076/T083 in parallel. External/conflict evidence T077-T079 and snapshot/classification T080-T081 are independent before transaction/ownership/lifecycle convergence T084-T087.

### User Story 3

Run bridge errors T088/T092-T093, ordinary-client behavior T089/T094-T095, and explicit-evidence work T091 independently before T096.

### User Story 4

Run diagnostics T098/T106-T107, interruption T101-T102/T108, repair T100/T109, client rotation T103/T110, and service rotation T104/T111 in parallel before CLI convergence T112-T113.

### User Story 5

Run backup T114/T120-T121, schema decisions T115-T116/T122, and writer drain T123 in parallel; converge on trust/upgrade/recovery T117-T119/T124-T127.

### User Story 6

Run default uninstall/reinstall T128-T129, purge T130-T131/T134, and retention modeling T135 independently before lifecycle/recovery/router/setup convergence T132-T138.

### User Story 7

Run first-party T139/T144, source trust T140-T142/T143/T145-T146, and degraded diagnostics T141/T148 independently before setup integration T147.

---

## Implementation Strategy

### MVP first

1. Complete isolated fixtures and the blocking test-first foundation.
2. Complete US1 through T073.
3. Validate service-only plus each selected-client combination from an offline-verified signed release.
4. Stop at the US1 checkpoint if a minimal internal milestone is needed; do not publish until all phases pass.

### Incremental delivery

1. Add US2 profile/conflict safety and US3 fail-open behavior to complete P1.
2. Add US4 operational recovery.
3. Develop US5 upgrade and US6 removal in parallel after US4.
4. Develop US7 catalog bootstrap any time after US1.
5. Complete every cross-cutting gate before release or autonomous-activation claims.

## Notes

- `[P]` never overrides the phase/test-first dependencies above; tasks without `[P]` are serialized where files or unfinished behavior overlap.
- Existing migrations 001-010, six MCP operations, and all Feature 001-003 behavior/tests remain unchanged.
- Never invoke Codex `mcp add` for an existing `skillwire` name; equivalent state stays external, while non-equivalent or ambiguous state blocks only that client pending external resolution.
- Automatic activation evidence is always separate and non-gating for deterministic installation; release claims still require Feature 003 attributable evidence.
- Never include raw client keys, database passwords, application peppers, GitHub tokens, account IDs, repository hashes, prompts/responses, client login state, or unrelated profile values in fixtures or evidence.
