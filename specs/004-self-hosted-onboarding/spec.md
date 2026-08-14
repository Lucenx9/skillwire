# Feature Specification: Self-Hosted Onboarding and Native Client Integration

**Feature Branch**: `004-self-hosted-onboarding`

**Created**: 2026-08-13

**Status**: Ready for Planning

**Input**: User description: "Enable a supported Linux developer to install and operate a self-hosted SkillWire release through one guided workflow, then use it from the developer's existing normal Codex and/or Claude Code profile without wrappers, manual configuration edits, credential leakage, or loss of unrelated profile state."

## Clarifications

### Session 2026-08-13

- Q: When both Codex and Claude Code are integrated, how should their SkillWire bearer credentials be separated? → A: Use one SkillWire account with a distinct API key for each selected client.
- Q: How should each normal client obtain its bearer key across terminal, IDE, desktop, logout, and reboot launches? → A: Use a minimal local MCP credential bridge that reads the client-specific key from the Linux credential service, with an explicitly disclosed restrictive-file fallback.
- Q: Should setup fail when a fresh client authenticates and exposes all six tools but the model does not automatically invoke SkillWire for the synthetic prompt? → A: No. Deterministic authentication, six-tool discovery, and a scripted search-to-exact-load journey gate setup success; automatic activation is reported separately and remains a release-acceptance gate.
- Q: When setup targets both clients but only one passes deterministic verification, what state should remain? → A: Keep the healthy service and verified client integration, roll back only the failed client, and return an incomplete non-success result.
- Q: If setup finds an equivalent working SkillWire MCP or plugin entry that it did not create, should uninstall later remove it? → A: No. Reuse it as external user-owned state, record the dependency without claiming ownership, and leave it untouched during repair and uninstall.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Complete a Guided Local Installation (Priority: P1)

An individual developer starts from a verified SkillWire release, runs one guided command, reviews the proposed machine and client changes, and receives a healthy local SkillWire installation connected to Codex, Claude Code, both clients, or neither. The developer continues to launch the ordinary `codex` and `claude` commands.

**Why this priority**: A safe one-command path from release artifact to a usable client is the core product outcome. Without it, self-hosting remains an operator-only procedure.

**Independent Test**: On each supported Linux and architecture fixture, start with Docker and one or both supported clients installed, run setup from an immutable release, and verify service readiness, initial account and key creation, the chosen client integrations, exactly six authenticated SkillWire tools, and a real search-to-exact-load journey without any manual configuration edit.

**Acceptance Scenarios**:

1. **Given** a clean supported host with normal Codex installed, **When** the user confirms setup for Codex only, **Then** setup installs the local service, integrates the existing user-scoped Codex profile, verifies exactly six authenticated SkillWire tools from a fresh normal `codex` process, completes a scripted search followed by the exact selected load and any fixture-required declared resource read, records a separate fresh-client automatic-activation diagnostic, and reports deterministic setup success even when that diagnostic observes no automatic invocation.
2. **Given** a clean supported host with normal Claude Code installed, **When** the user confirms setup for Claude Code only, **Then** setup installs the local service, integrates the existing user-scoped Claude profile, verifies exactly six authenticated SkillWire tools from a fresh normal `claude` process, completes a scripted search followed by the exact selected load and any fixture-required declared resource read, records a separate fresh-client automatic-activation diagnostic, and reports deterministic setup success even when that diagnostic observes no automatic invocation.
3. **Given** a clean supported host with both clients installed, **When** the user confirms setup for both, **Then** one service and one initial account serve exactly one SkillWire integration in each normal client profile, and both fresh client processes pass authenticated discovery and the smoke journey.
4. **Given** the user selects neither client, **When** service setup completes, **Then** SkillWire is healthy and administrable, neither client profile is modified, and the final report clearly states that client integration remains pending.
5. **Given** setup targets both clients and only one passes deterministic verification, **When** per-client recovery completes, **Then** the healthy service and verified client integration remain, only the failed client's configuration and newly created credential state are rolled back, and setup returns an incomplete non-success result with repair guidance.

---

### User Story 2 - Preserve Existing Client Profiles (Priority: P1)

A developer with an established Codex or Claude Code profile can add SkillWire without losing or duplicating existing authentication, settings, histories, plugins, skills, hooks, or unrelated MCP servers. The user sees a redacted preview and can recover the prior state if any selected client fails validation.

**Why this priority**: Native integration is unsafe if onboarding can damage the profiles developers rely on for ordinary work.

**Independent Test**: Populate disposable normal user homes with arbitrary unrelated configuration and controlled SkillWire conflicts, run install, repair, upgrade, and uninstall, and compare structured before-and-after state while proving the active repository and its `.codex`, `.claude`, `.mcp.json`, and skill paths are unchanged.

**Acceptance Scenarios**:

1. **Given** a normal Codex profile containing unrelated plugins, skills, MCP servers, model settings, and login state, **When** Codex integration succeeds, **Then** every unrelated entry remains semantically and byte-for-byte unchanged where the client format preserves bytes, exactly one user-scoped `skillwire` MCP entry exists, and exactly one SkillWire activation plugin is installed through the supported lifecycle.
2. **Given** a normal Claude profile containing unrelated plugins, hooks, skills, MCP servers, settings, and login state, **When** Claude integration succeeds, **Then** every unrelated entry remains semantically and byte-for-byte unchanged where supported, exactly one user-scoped SkillWire dependency exists, and exactly one bounded activation adapter is installed through the supported lifecycle.
3. **Given** a managed or policy-controlled profile, **When** the relevant integration is not permitted, **Then** setup makes no prohibited change, explains the redacted conflict, leaves the client usable, and does not report that client as integrated.
4. **Given** an existing same-name or same-endpoint SkillWire registration, **When** setup evaluates it, **Then** an equivalent valid entry is reused without duplication as external user-owned state and remains untouched by setup, repair, upgrade, and uninstall, while a non-equivalent or ambiguous entry blocks only that client's installation, is reported as an exact redacted conflict requiring external user resolution, and is never adopted, renamed, overwritten, disabled, or removed automatically. If the other selected client succeeds independently, that verified integration and the healthy service remain installed.
5. **Given** setup, repair, upgrade, or uninstall is run from a repository, **When** it completes or fails, **Then** no repository `.codex`, `.claude`, `.mcp.json`, skill file, or other repository content has been created or modified.

---

### User Story 3 - Keep Normal Clients Usable During SkillWire Failure (Priority: P1)

A developer can continue ordinary Codex and Claude Code work when SkillWire is stopped, unreachable, unauthenticated, incompatible, or misconfigured. SkillWire activation stops after the bounded attempt and diagnostics remain available without exposing secrets.

**Why this priority**: An optional guidance service must not become a startup or availability dependency for the user's primary development clients.

**Independent Test**: For each selected client, inject service outage, endpoint, credential, authentication, schema, and tool-contract failures; start a fresh normal client process and verify startup and unrelated capabilities continue with no retry loop or repeated authentication prompt.

**Acceptance Scenarios**:

1. **Given** SkillWire is stopped, **When** the user launches normal `codex`, **Then** Codex starts, unrelated configuration remains available, the activation adapter performs no unbounded retry, and the optional SkillWire failure does not terminate startup.
2. **Given** SkillWire is stopped, **When** the user launches normal `claude`, **Then** Claude Code starts, unrelated configuration remains available, the activation adapter performs no unbounded retry, and the optional SkillWire failure does not terminate startup.
3. **Given** the persistent SkillWire credential is unavailable or rejected, **When** either selected client starts, **Then** the client remains usable, no repeated credential prompt occurs, and diagnostics distinguish missing credential from rejected authentication without revealing the value.
4. **Given** a user explicitly requests SkillWire search, **When** the service is healthy and relevant content exists, **Then** the selected client performs the existing user-requested search behavior without weakening eligibility, provenance, or bounded-load rules.

---

### User Story 4 - Operate, Diagnose, and Repair Idempotently (Priority: P2)

A developer can inspect status, diagnose failures, repeat setup, and repair SkillWire-owned state without rotating healthy secrets, duplicating entries, deleting data, or rewriting unrelated client configuration.

**Why this priority**: Self-hosting needs a reliable recovery path that does not require understanding the service internals.

**Independent Test**: Capture installation and client state, run setup repeatedly, interrupt each mutating phase, inject every documented diagnostic condition, and run repair previews and confirmed repairs while checking ownership metadata, state equality, and rollback evidence.

**Acceptance Scenarios**:

1. **Given** a healthy complete installation, **When** setup is run again with the same choices, **Then** it reports the installation as current without rotating secrets, creating an account or key, duplicating MCP or plugin entries, re-registering sources, recreating data storage, or rewriting unchanged files.
2. **Given** setup is interrupted after any mutation begins, **When** transactional recovery runs, **Then** the last validated service and client state is restored automatically or setup stops with precise recoverable steps and never reports completion.
3. **Given** any documented failure class, **When** the user runs `skillwire doctor`, **Then** the output identifies the failing layer with a stable code, redacted evidence, and a safe next action.
4. **Given** drift only in SkillWire-owned state, **When** the user previews and confirms repair, **Then** repair changes only proven SkillWire-owned state and preserves data, secrets, and unrelated configuration.

---

### User Story 5 - Upgrade Across Safe and Forward-Only Boundaries (Priority: P2)

A developer can upgrade a verified SkillWire release with a validated database backup, explicit migration risk, bounded downtime, and a truthful rollback or restore path.

**Why this priority**: The existing schema has forward-only boundaries; an unsafe image rollback can corrupt data or invalidate runtime assumptions.

**Independent Test**: Exercise an upgrade without a schema change and an upgrade across migration `010` using disposable persistent data, client profiles, a restorable backup, interrupted phases, and both compatible and incompatible rollback attempts.

**Acceptance Scenarios**:

1. **Given** a verified target release with no schema change, **When** upgrade succeeds, **Then** service, catalog, advisory, readiness, client credentials, client integrations, repository memory, and unrelated profile state remain valid, and a compatible application/configuration rollback remains available.
2. **Given** a verified target release crossing the forward-only migration `010` boundary, **When** the user confirms the warned maintenance operation, **Then** all writers are drained, a backup is created and restore-validated before migration, the new release passes service and client verification, and an image-only rollback to a pre-`010` release is refused.
3. **Given** a post-migration verification failure that requires database restoration, **When** automatic image/configuration rollback is unsafe, **Then** the tool keeps writers stopped and supplies exact, redacted restore instructions that identify the validated backup and expected compatible release.

---

### User Story 6 - Uninstall Selectively and Preserve Data by Default (Priority: P2)

A developer can remove SkillWire integrations and stop the service while retaining database data, backups, secrets, and every unrelated client setting unless permanent deletion is separately and explicitly requested.

**Why this priority**: Uninstall must be reversible by default and must not use broad profile or filesystem deletion.

**Independent Test**: Install into populated disposable profiles, run default uninstall, reinstall, and then run the separate permanent-removal flow while checking exact owned entries, paths, volumes, confirmations, and duplicate counts.

**Acceptance Scenarios**:

1. **Given** an installed service and one or both client integrations, **When** the user confirms default uninstall, **Then** only SkillWire-owned client entries and activation plugins are removed, containers stop, unrelated client state remains unchanged, and PostgreSQL data, backups, and secrets remain available for reinstall.
2. **Given** retained data from uninstall, **When** the user reinstalls, **Then** existing service identity and data are reused safely and no duplicate client registration is created.
3. **Given** the user requests permanent removal, **When** the tool displays the exact data paths, backup paths, secret paths, and volumes and receives a separate explicit confirmation naming that scope, **Then** only the named SkillWire-owned data is deleted and the result states what is no longer recoverable.

---

### User Story 7 - Start with a Trustworthy Catalog (Priority: P3)

A fresh first-party-only installation immediately exposes the ten trusted release skills without GitHub credentials or network access to GitHub. The user may separately opt into curated imported-source bootstrap choices, each of which remains subject to the existing verification, quarantine, provenance, snapshot, and advisory rules.

**Why this priority**: The first successful client journey must work offline from GitHub while preserving the distinction between trusted first-party content and structurally verified imports.

**Independent Test**: Install with no GitHub token and blocked GitHub network access, verify all ten first-party skills and the smoke journey, then opt into each offered imported source and prove no revision becomes eligible before the existing pipeline permits it.

**Acceptance Scenarios**:

1. **Given** first-party-only setup with no GitHub credential, **When** installation finishes, **Then** exactly the ten immutable first-party launch skills are available and no GitHub request has occurred.
2. **Given** the offered `mattpocock/skills` or `obra/superpowers` bootstrap choice, **When** the user does not opt in, **Then** the source is not registered, fetched, trusted, or represented as part of the first-party release.
3. **Given** explicit opt-in and a separate read-only GitHub credential, **When** source bootstrap runs, **Then** content traverses the existing ingestion, verification, quarantine, provenance, snapshot, classification, and advisory boundaries, and no source bypasses quarantine.
4. **Given** source synchronization fails, **When** the user accesses first-party or previously verified eligible content, **Then** the MCP service remains ready and the source is reported as degraded rather than making SkillWire unavailable.

### Edge Cases

- A required port is occupied before setup starts; the preview identifies it and no service mutation occurs until the user selects an available supported endpoint.
- Docker is absent, stopped, inaccessible, or installed without the required Compose capability; setup explains the prerequisite and never installs or reconfigures Docker without separate explicit consent.
- Rootless Docker is already functional; setup uses it without requiring root or changing daemon ownership.
- The release artifact, image digest, plugin package, marketplace metadata, catalog, or advisory chain fails integrity verification; onboarding stops before trusting or starting the affected artifact.
- The database is newer than the selected SkillWire release, an applied migration checksum drifts, a migration lock times out, or migration `010` fails; readiness and completion remain false and no older image is started against the incompatible schema.
- Liveness succeeds while readiness fails; setup reports the failing readiness dependency and never treats liveness as completion.
- Initial account or API-key creation succeeds but secure credential persistence or selected-client verification fails; the transaction rolls back client changes and retains or revokes partial security state according to recorded ownership without printing the key.
- A client profile is missing, malformed, concurrently modified, read-only, symlinked outside its expected root, or controlled by policy; setup refuses unsafe replacement and preserves the original.
- A selected client version is missing, unsupported, or changes configuration during setup; setup stops that integration, restores its snapshot, and leaves other independently successful choices accurately reported.
- Two concurrent setup, repair, upgrade, or uninstall processes target one installation; only one mutating operation proceeds and the other exits safely without partial writes.
- A secret file fallback is necessary because no supported secure store exists; the preview identifies the exact path and protection model, and setup rejects permissive ownership or mode.
- A normal client is launched from a terminal, IDE, or desktop session after logout or reboot; the persistent credential remains available without a manual per-session export.
- A SkillWire endpoint is reachable but exposes fewer, more, or differently named tools; the selected client fails verification and setup does not report completion.
- Imported source sync is rate-limited, unavailable, quarantined, revoked, or produces an integrity mismatch; verified first-party operation remains available and diagnostics remain bounded and redacted.
- Default uninstall is interrupted; recovery converges to either the last complete installed state or a complete data-preserving uninstall without removing ambiguous user-owned entries.

## Requirements *(mandatory)*

### Functional Requirements

#### Guided Setup and Service Installation

- **FR-001**: The product MUST provide one documented `skillwire setup` workflow that can install the service and integrate Codex, Claude Code, both, or neither without requiring manual configuration-file edits.
- **FR-002**: Before any mutation, setup MUST display the selected release identity, installation paths, service endpoint, ports, containers, persistent data, secret locations or stores, client scopes, and planned additions, changes, and removals in a redacted preview.
- **FR-003**: Every mutating administrative command MUST provide a non-destructive preview and MUST require explicit confirmation unless the user supplied a documented non-interactive confirmation flag after reviewing equivalent machine-readable output.
- **FR-004**: Setup MUST detect the supported operating system, architecture, Docker Engine access, Compose capability, rootless or rootful mode, selected client presence and version, required ports, filesystem permissions, secure-credential capabilities, and managed client policy before mutation.
- **FR-005**: Setup MUST NOT install Docker, alter Docker daemon configuration, grant Docker-group membership, or obtain root privileges without a separate explicit user decision that identifies the system-level change.
- **FR-006**: Setup MUST install SkillWire-owned files under appropriate user-scoped XDG configuration, data, state, cache, and executable locations and MUST record every owned path and client entry in secure installation metadata.
- **FR-007**: Setup MUST validate all target paths, reject traversal and symlink escapes, and refuse to overwrite an existing path it cannot prove is SkillWire-owned.
- **FR-008**: Normal installation MUST use immutable, versioned release artifacts and digest-verified production images and MUST NOT build arbitrary repository contents.
- **FR-009**: Setup MUST generate unique database and application secrets with cryptographically strong randomness, MUST store them with restrictive access, and MUST NOT print their values.
- **FR-010**: The default service topology MUST bind SkillWire to loopback and MUST NOT publish PostgreSQL to the host or external network.
- **FR-011**: Setup MUST preserve the existing persistent PostgreSQL data volume across restart, repair, and upgrade unless the user explicitly confirms permanent deletion.
- **FR-012**: Setup MUST use the existing migration gate, apply each pending migration no more than once, reject checksum drift and newer schemas, and require migration success before application startup.
- **FR-013**: Setup and upgrade MUST respect the forward-only migration `010` boundary and MUST prohibit a pre-`010` application from starting against a post-`010` database.
- **FR-014**: Setup MUST wait for both liveness and readiness and MUST treat liveness without readiness as incomplete.
- **FR-015**: After readiness, setup MUST create exactly one initial local account and one distinct bearer API key for each selected client on a new installation; repeated setup MUST reuse each healthy client-specific key rather than creating another account or key. If a client transaction fails, setup MUST remove its newly persisted credential reference and revoke any key created solely for that failed transaction.
- **FR-016**: Setup MUST report overall success only after the service, migration, catalog, advisory, credential, exact six-tool, and scripted smoke-journey checks pass for every selected client. If at least one selected client passes and another fails, setup MUST retain the healthy service and each verified integration, roll back only failed client transactions, and return an incomplete non-success result. A separately reported automatic-activation diagnostic MUST NOT change a client's deterministic result.

#### Native Codex Integration

- **FR-017**: Codex integration MUST target the normal user-scoped Codex profile used by the ordinary `codex` command and MUST NOT require `codex-skillwire`, an alternate `CODEX_HOME`, or another wrapper.
- **FR-018**: Codex integration MUST use supported Codex configuration and plugin-management interfaces, MUST never modify repository `.codex` content, and MUST not copy or replace existing Codex authentication.
- **FR-019**: Codex integration MUST install the existing `skillwire-autonomous-activation` package through the normal user-scoped plugin lifecycle and MUST verify its immutable release identity and allowlisted file inventory.
- **FR-020**: Codex integration MUST register exactly one enabled user-scoped MCP server named `skillwire` using the exact configured endpoint and the existing six-tool contract.
- **FR-021**: Codex integration MUST preserve every unrelated MCP server, plugin, skill, model setting, login, history, and configuration field and MUST avoid duplicate SkillWire marketplace, plugin, or MCP entries.
- **FR-022**: The default Codex MCP registration MUST be optional and fail-open; it MUST NOT set `mcp_servers.skillwire.required` to true unless the user later selects a separately documented advanced option.
- **FR-023**: Codex verification MUST launch a fresh normal Codex process after mutation and MUST prove authenticated discovery of exactly `search_skills`, `load_skill`, `read_skill_resource`, `list_repo_memory`, `record_skill_outcome`, and `forget_repo_memory`.

#### Native Claude Code Integration

- **FR-024**: Claude Code integration MUST target the normal user-scoped Claude profile used by the ordinary `claude` command and MUST NOT require `claude-skillwire`, an alternate `CLAUDE_CONFIG_DIR`, or another wrapper.
- **FR-025**: Claude Code integration MUST use supported Claude Code user-scope plugin and MCP management interfaces and MUST never create repository `.claude`, `.mcp.json`, or skill files.
- **FR-026**: Claude Code integration MUST install exactly one minimal SkillWire activation plugin or adapter that reproduces Feature 003's bounded activation policy without bundling remote catalog skills or executable payloads.
- **FR-027**: Claude Code integration MUST register exactly one user-scoped SkillWire MCP dependency using the exact configured endpoint and MUST preserve every unrelated plugin, MCP server, setting, hook, skill, login, and history.
- **FR-028**: Claude Code integration MUST detect and avoid equivalent duplicates, MUST refuse silent overwrite of conflicting entries, and MUST respect read-only managed configuration.
- **FR-029**: Claude verification MUST launch a fresh normal Claude Code process after mutation and MUST prove authenticated discovery of the same exact six SkillWire tools.

#### Existing-Profile Safety and Ownership

- **FR-030**: Before changing a client profile, onboarding MUST inspect its effective user and managed configuration, detect existing SkillWire entries and conflicts, and present a redacted structured change preview. An equivalent pre-existing integration remains external user-owned state and MUST remain untouched. A non-equivalent or ambiguous integration MUST block only that client's installation, MUST be reported as an exact redacted conflict requiring external user resolution, and MUST NOT be adopted, renamed, overwritten, disabled, or removed automatically. When both clients are selected, a blocked client MUST NOT roll back an independently successful client or the healthy service.
- **FR-031**: Before the first client mutation in an operation, onboarding MUST create a secure recoverable backup or transactional snapshot and MUST record the original state identity.
- **FR-032**: Each client's changes MUST form an independent structured, atomic, narrowly scoped transaction and be validated before replacement; a failed write or validation MUST restore only that client's original state automatically and MUST NOT roll back another verified client integration.
- **FR-033**: Onboarding MUST detect concurrent profile modification and MUST refuse to replace a profile based on a stale snapshot.
- **FR-034**: Installation ownership metadata MUST identify only entries and files created by SkillWire, with sufficient identity to distinguish them from similar user-owned state. An equivalent pre-existing component MAY be recorded only as an external user-owned dependency, MUST NOT become SkillWire-owned, and MUST remain untouched by setup, repair, upgrade, uninstall, and permanent removal.
- **FR-035**: Repair, upgrade, and uninstall MUST mutate only state proven by current ownership metadata and MUST never rewrite, normalize, reorder, or remove unrelated configuration or an external user-owned dependency.
- **FR-036**: Automated profile tests MUST cover arbitrary pre-existing MCP servers, plugins, skills, hooks, authentication, settings, and comments where the official format and management interface preserve comments.

#### Credential Delivery

- **FR-037**: The existing raw SkillWire bearer API key MUST never be written into Codex or Claude configuration files, static authorization headers, plugin packages, marketplace metadata, or repository files.
- **FR-038**: Raw SkillWire API keys, GitHub tokens, PostgreSQL passwords, and application secrets MUST NOT appear in command-line arguments, process listings, logs, terminal history, configuration previews, diffs, test fixtures, generated reports, crash output, or Git commits.
- **FR-039**: Each selected client MUST connect through a minimal local MCP credential bridge that obtains its client-specific key from the Linux credential service and supplies it only for SkillWire MCP authentication and transport. The bridge MUST work for normal supported terminal, IDE, desktop, and harness launches after logout, reboot, and new client sessions.
- **FR-040**: Installation MUST NOT require the user to export `SKILLWIRE_API_KEY` before each launch and MUST NOT silently edit shell startup files.
- **FR-041**: Existing Codex and Claude Code authentication MUST remain untouched and MUST NOT be copied into another profile or credential store.
- **FR-042**: When the Linux credential service is unavailable, the bridge MAY use an explicitly disclosed client-specific credential file fallback. Setup MUST disclose the exact file path and risk, create it with restrictive ownership and permissions, and refuse completion when those protections cannot be enforced.
- **FR-043**: GitHub ingestion credentials MUST be optional, read-only, stored separately from client bearer keys, and absent from first-party-only installation and operation.
- **FR-044**: Credential creation, persistence, verification, rotation, recovery, and removal MUST be independently testable per client with canary secret values and zero disclosure across all captured outputs and process metadata. Rotating, removing, or losing one client's key MUST NOT invalidate another selected client's key.

#### Persistent Credential Transport Decision

- **PD-001**: Planning MUST define the bridge protocol, credential-service integration, restrictive-file fallback, process boundary, lifecycle, and client registration for every supported launch surface. The bridge serves only SkillWire MCP authentication and transport, MUST satisfy FR-037 through FR-044, MUST remain fail-open, and MUST NOT wrap or replace `codex` or `claude`. Direct static headers, per-shell manual exports, silent shell-profile edits, and a fallback file shared between clients are rejected options.
- **PD-002**: Planning MUST provide primary-source evidence and executable terminal, IDE, desktop, logout, reboot, missing-credential, and rejected-authentication tests for the bridge before implementation tasks may declare client onboarding complete.

#### Fail-Open Activation and End-to-End Verification

- **FR-045**: A stopped, unreachable, unauthenticated, rate-limited, incompatible, or misconfigured SkillWire service MUST NOT prevent normal Codex or Claude Code startup or unrelated work.
- **FR-046**: Each activation adapter MUST preserve Feature 003's one-search, one-exact-load, optional-one-declared-resource bound for one unchanged task intent, with no retry, query reformulation, second-candidate load, or repeated authentication prompt after failure.
- **FR-047**: Selected-client verification MUST fail when the client cannot authenticate, cannot discover the MCP server, or sees a tool count, name, or contract different from the existing six-tool surface, even if service health checks pass.
- **FR-048**: Deterministic final verification for each selected client MUST perform one scripted authenticated search, load the exact returned revision, optionally read one declared resource when the fixture calls for it, and verify immutable provenance and advisory information.
- **FR-049**: Verification MUST run and separately report a specialized synthetic automatic-activation diagnostic from a fresh normal client process. A non-activation MUST NOT roll back or fail a client that passed deterministic verification, but the recorded release-candidate evidence for each client MUST meet Feature 003's applicable attributable automatic-activation acceptance target before SkillWire claims that client's autonomous activation is release-ready. Automatic and explicit user-requested evidence MUST remain separate and retain Feature 003's local-guidance precedence, privacy, attribution, and positive-outcome rules.
- **FR-050**: Diagnostics for a client integration failure MUST identify the failing layer without emitting credential values, prompts, responses, repository hashes, local paths beyond redacted owned locations, or unrelated profile content.

#### Catalog Bootstrap and Source Boundaries

- **FR-051**: Every fresh installation MUST make the ten immutable trusted first-party launch skills available without GitHub credentials or GitHub network access.
- **FR-052**: The first-party catalog MUST retain its immutable release, provenance, advisory-chain, and integrity checks during setup, repair, upgrade, and verification.
- **FR-053**: `mattpocock/skills` and `obra/superpowers` MUST be presented only as explicit opt-in bootstrap choices and MUST NOT be silently registered, trusted, or represented as part of the first-party immutable release snapshot.
- **FR-054**: Opted-in sources MUST use the existing fixed-origin ingestion, verification, quarantine, provenance, immutable snapshot, classification, dependency, and advisory boundaries; onboarding MUST NOT bypass quarantine or directly install imported content into a client.
- **FR-055**: Imported skills and resources MUST remain untrusted inert text, MUST never be executed, and MUST never be copied into client or repository skill trees.
- **FR-056**: Source synchronization failure MUST be reported as a degraded source condition and MUST NOT make the MCP service or eligible verified cached content unavailable.
- **FR-057**: First-party-only mode MUST not contact GitHub.

#### Administrative Interface, Idempotency, and Repair

- **FR-058**: The administrative interface MUST provide stable behavior equivalent to `skillwire setup`, `setup --clients codex`, `setup --clients claude`, `setup --clients codex,claude`, `status`, `doctor`, `clients list`, `clients install <client>`, `clients verify <client>`, `clients uninstall <client>`, `repair`, `upgrade`, `backup`, and `uninstall`.
- **FR-059**: Every command MUST offer concise human-readable output and a versioned machine-readable form, and MUST use stable exit classes for success, invalid invocation, unsupported prerequisite, policy or ownership conflict, degraded state, service failure, credential or authentication failure, client-contract failure, schema incompatibility, rollback required, and user cancellation.
- **FR-060**: Repeated setup against a healthy unchanged installation MUST produce no secret rotation, account or key creation, duplicate plugin or MCP entry, source re-registration, volume recreation, catalog/advisory mutation, repository-memory loss, or unnecessary file write.
- **FR-061**: `skillwire doctor` MUST distinguish service stopped, PostgreSQL unavailable, pending migration, incompatible or drifted schema, invalid catalog or advisory integrity, missing client, unsupported client version, missing or outdated plugin, absent/conflicting/duplicate MCP configuration, unavailable credential, rejected authentication, unreachable endpoint, six-tool mismatch, unavailable activation adapter, and degraded source synchronization.
- **FR-062**: `skillwire repair` MUST default to preview, MUST name the exact SkillWire-owned state it proposes to change, MUST never delete data automatically, and MUST refuse ambiguous ownership.
- **FR-063**: Mutating operations MUST be serialized per installation and MUST recover from interruption to a known validated boundary without leaving a success marker for partial work.
- **FR-064**: Setup and repair MUST not rotate secrets merely to recover service or client configuration; rotation requires an explicit separately previewed action.
- **FR-065**: Administrative output MUST end with a concise state summary, affected components, selected-client results, backup or rollback location when applicable, and safe recovery instructions.

#### Backup, Upgrade, and Rollback

- **FR-066**: `skillwire backup` MUST create a protected backup of all authoritative PostgreSQL data and the minimum SkillWire-owned configuration and metadata needed for recovery, without copying unrelated client authentication or configuration.
- **FR-067**: A backup MUST NOT be reported valid until it passes integrity checks and an isolated restore validation appropriate to the release.
- **FR-068**: Upgrade MUST verify the target release identity and every required artifact before stopping or changing the current installation.
- **FR-069**: Upgrade MUST create and validate a pre-upgrade PostgreSQL backup and MUST identify whether the target contains a forward-only migration before seeking final confirmation.
- **FR-070**: Upgrade MUST drain application, ingestion, and administration writers when required by the migration boundary and MUST keep them drained until schema, catalog, advisory, readiness, and client integration checks pass.
- **FR-071**: Upgrade MUST preserve client credentials, installation ownership, repository memory, persistent data, and unrelated client configuration.
- **FR-072**: Upgrade MUST automatically roll back application and SkillWire-owned configuration when schema compatibility permits and MUST refuse unsafe image-only rollback after a forward-only schema migration.
- **FR-073**: When database restoration is required, upgrade MUST provide exact restore instructions, the validated backup identity, the compatible application release, expected data-loss boundary, and a warning that restored backups may reintroduce previously erased repository memory.

#### Selective Uninstall

- **FR-074**: Default uninstall MUST remove only proven SkillWire-owned Codex and Claude Code entries and activation plugins, MUST leave every reused external user-owned SkillWire component untouched, stop SkillWire containers, and preserve PostgreSQL data, backups, secrets, and ownership metadata needed for recovery.
- **FR-075**: Default uninstall MUST preserve every unrelated client setting, login, plugin, hook, skill, MCP server, history, and managed policy entry.
- **FR-076**: Permanent removal MUST be a separate operation from default uninstall and MUST require an explicit confirmation that displays and names the exact SkillWire-owned paths and volumes to delete.
- **FR-077**: Uninstall and reinstall MUST converge without duplicate client entries or accounts and MUST preserve existing data unless permanent removal was completed.

#### Security, Privacy, and Constitutional Boundaries

- **FR-078**: The feature MUST preserve remote-only delivery: catalog skills and resources cross the client boundary only as transient MCP response data and are never installed locally.
- **FR-079**: The feature MUST preserve retrieval-only behavior: imported text, scripts, binaries, package instructions, and hooks are never executed by onboarding or the service.
- **FR-080**: The feature MUST preserve the exact six-tool protocol contract, account and repository isolation, immutable provenance, advisory integrity, safe resource paths, bounded content, authentication, rate limits, and auditable safe failures established by Features 001 through 003.
- **FR-081**: Configuration, secrets, backups, snapshots, and ownership metadata MUST use restrictive permissions, bounded contents, validated paths, and redacted diagnostics.
- **FR-082**: All network operations MUST use deadlines, bounded retries appropriate to the administrative operation, verified destinations, and safe cancellation; the activation path retains Feature 003's no-retry rule.
- **FR-083**: The supported installation path MUST NOT rely on `curl | sh`; any convenience bootstrap MUST first download a versioned artifact and verify its integrity before execution.
- **FR-084**: Onboarding MUST collect no telemetry by default and MUST not log account identifiers, repository hashes, prompts, responses, raw Git metadata, client logins, API keys, GitHub tokens, or PostgreSQL passwords.
- **FR-085**: A user-supplied client profile, source, release, path, endpoint, or configuration conflict MUST be treated as untrusted input and validated before use.

#### Test and Release Evidence

- **FR-086**: Required automated tests MUST use disposable simulated normal user homes and MUST never mutate a developer's real home directory or active repository.
- **FR-087**: Automated acceptance MUST cover all 28 numbered acceptance scenarios in this specification, including Codex-only, Claude-only, both, existing profiles, repeated setup, interruption, fail-open failures, six-tool discovery, deterministic scripted journeys, separately reported automatic and explicit search journeys, both upgrade classes, both uninstall classes, managed conflicts, and zero repository writes.
- **FR-088**: Secret-leak tests MUST inspect process arguments, environment reports, logs, terminal captures, configuration diffs, backups, generated reports, test artifacts, and repository changes using canary values and MUST find zero raw secret occurrences.
- **FR-089**: Profile-preservation tests MUST prove install, repair, upgrade, and uninstall retain arbitrary unrelated configuration, authentication, plugins, skills, hooks, MCP servers, and comments where supported.
- **FR-090**: Release gates MUST run all existing Feature 001 through 003 tests and invariants unchanged; any regression blocks Feature 004 release.
- **FR-091**: A manual real-profile smoke MAY run only with explicit operator consent, disposable or recoverable backups, redacted before-and-after evidence, and no secret capture.
- **FR-092**: Release evidence MUST record the tested release, operating system, architecture, Docker Engine, Compose, PostgreSQL image, Codex, and Claude Code versions and MUST not generalize beyond that matrix.

### Key Entities

- **SkillWire Installation**: One user-owned self-hosted deployment, identified by release, service endpoint, installation paths, persistent database storage, schema boundary, selected clients, catalog release, and current health state.
- **Installation Ownership Record**: Secure metadata that proves which paths, profile entries, plugin identities, MCP registrations, containers, volumes, credentials, and backups SkillWire created. It is the authority for repair and selective uninstall and cannot confer ownership on pre-existing user state.
- **External Integration Dependency**: An equivalent pre-existing SkillWire MCP or plugin component reused by setup without duplication. Its identity and verification result may be recorded, but it remains user-owned and is never rewritten, repaired, or removed by SkillWire.
- **Client Integration**: The SkillWire-owned user-scoped state for one supported normal client. It records client identity and version, exact endpoint, MCP registration identity, activation-adapter identity, credential reference, verification state, and pre-change snapshot identity without storing raw credentials.
- **Credential Bridge**: A minimal local transport component that serves only the existing SkillWire MCP connection and injects one client-specific bearer key from the Linux credential service or disclosed restrictive-file fallback. It is not a client wrapper and owns no catalog, activation, ranking, or remote-skill behavior.
- **Credential Reference**: A non-secret identifier used by the credential bridge to resolve one client-specific bearer key. Each selected client has exactly one owned reference; it is separate from the raw key and from existing client authentication.
- **Profile Snapshot**: A secure, recoverable, redacted-before-reporting representation of one client profile immediately before a SkillWire mutation, including concurrency identity and restoration status.
- **Release Manifest**: Immutable identity and integrity metadata for the installer, production service images, Compose definition, catalog, activation adapters, marketplace inputs, migrations, and supported compatibility matrix.
- **Operation Journal**: Transactional state for setup, repair, upgrade, or uninstall, including preview identity, confirmation, completed phases, rollback boundary, and final disposition without secret values.
- **Backup Set**: An integrity-checked, restore-validated PostgreSQL backup plus the minimum SkillWire-owned recovery metadata, tied to a release and schema boundary.
- **Diagnostic Finding**: A stable categorized status for one service, migration, catalog, credential, client, activation, tool-contract, or source-sync condition, with redacted evidence and safe remediation.
- **Bootstrap Source Choice**: An explicit opt-in registration for a known imported source, separate from the first-party catalog and governed by the existing ingestion and quarantine lifecycle.

### Scope Boundaries

This feature adds self-hosted lifecycle administration and native user-scoped adapters around the existing service. It does not change the six MCP operation schemas, execute imported content, install catalog skills locally, replace client authentication, or make either activation adapter part of the protocol-independent core.

The following are out of scope:

- Hosted SkillWire SaaS, a web dashboard, billing, or enterprise multi-user administration
- Organization-wide or managed-policy deployment of client integration
- Automatic ingestion of arbitrary repositories or silent trust of curated imports
- Execution of imported skill code, scripts, binaries, hooks, or dependencies
- Installation of remote catalog skill bundles into a client, user skill directory, or repository
- Replacement of Codex or Claude Code login and authentication
- Default use of isolated client profiles, wrappers, alternate client homes, or repository configuration
- Operating systems, distributions, architectures, container runtimes, and client versions outside the tested MVP matrix
- Silent shell-startup modification
- OAuth authentication for the MVP credential path
- Automatic destructive repair or deletion of persistent data

### Supported MVP Compatibility Baseline

The first release MUST be tested and supported only for the following matrix; other platforms MUST be reported as unsupported rather than receiving untested mutation:

- **Linux distributions**: 64-bit Ubuntu 24.04 LTS and Debian 12 or 13.
- **Architectures**: `amd64` and `arm64`.
- **Container runtime**: Docker Engine 29.7.2 or newer compatible 29.x release with Docker Compose plugin 5.4.0 or newer compatible 5.x release, including an already functional rootless mode.
- **Database**: the release-pinned PostgreSQL 17.10 image and existing migrations `001` through `010`; PostgreSQL is supplied by the verified deployment rather than required as a host installation.
- **Codex**: Codex CLI 0.147.0 or a later release explicitly certified by SkillWire against the same user-scoped configuration, plugin-manager, and MCP behavior.
- **Claude Code**: Claude Code 2.0.13 or a later release explicitly certified by SkillWire against user-scoped plugin marketplace and MCP behavior.

This baseline is deliberately narrower than vendor platform availability. Every SkillWire release MUST publish the exact certified versions and image digests; support for an additional platform or a changed major version requires recorded compatibility evidence.

### Primary Documentation Evidence

Volatile integration facts were checked on 2026-08-13 against primary sources:

- OpenAI's [Codex MCP documentation](https://developers.openai.com/codex/mcp) documents the normal `~/.codex/config.toml` location, shared Codex CLI/IDE/desktop MCP configuration, bearer-token environment references, and optional `required` behavior.
- OpenAI's [Codex configuration reference](https://developers.openai.com/codex/config-reference) documents `bearer_token_env_var`, `env_http_headers`, OAuth credential storage, and the startup-failing meaning of `mcp_servers.<id>.required`.
- OpenAI's [Codex plugin documentation](https://developers.openai.com/codex/plugins) documents the normal plugin catalog and lifecycle.
- Anthropic's [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) documents user-scoped MCP configuration and its normal user-profile location.
- Anthropic's [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference) documents user-scope plugin installation and management; the official changelog records the plugin system in 2.0.12 and the native-build `/plugin` fix in 2.0.13.
- Docker's [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) and [Debian](https://docs.docker.com/engine/install/debian/) installation pages document supported releases and architectures; the [rootless](https://docs.docker.com/engine/security/rootless/) and [Compose plugin](https://docs.docker.com/compose/install/linux/) pages document the supported runtime modes used by prerequisite checks.
- PostgreSQL 18's [SQL dump](https://www.postgresql.org/docs/current/backup-dump.html) and [cluster upgrade](https://www.postgresql.org/docs/current/upgrading.html) documentation establish the logical backup, restore, and major-version compatibility baseline. The deployed database remains release-pinned to PostgreSQL 17.10.

Repository evidence on the same date pins the existing adapter and current release matrix to Codex 0.147.0, Docker Engine 29.7.2, Compose 5.4.0, multi-architecture `amd64`/`arm64` Node and PostgreSQL image manifests, PostgreSQL 17.10, and migrations through `010`. Planning MUST recheck volatile vendor documentation and package versions before freezing implementation tasks.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On every supported OS/architecture fixture, at least 95% of first-attempt participants who meet prerequisites complete release verification, service setup, and one selected-client integration in 15 minutes or less without manually editing configuration files.
- **SC-002**: 100% of successful selected-client installations expose exactly six named SkillWire tools and complete one authenticated search followed by an exact immutable load from a fresh ordinary client process.
- **SC-003**: Across Codex-only, Claude-only, and dual-client acceptance suites, 100% of ordinary `codex` and `claude` startup attempts succeed when SkillWire is healthy, stopped, unreachable, unauthenticated, or misconfigured.
- **SC-004**: Install, repeated setup, repair, upgrade, and uninstall preserve 100% of seeded unrelated client configuration and authentication state in disposable-profile tests, with zero repository client-directory writes.
- **SC-005**: Repeating setup ten times against one healthy installation results in exactly one account, exactly one active onboarding key per selected client, one service data volume, one SkillWire MCP registration per selected client, and one activation adapter per selected client, with zero secret rotation or unchanged-file rewrites.
- **SC-006**: Every injected interruption point either restores the last validated state automatically or produces a recoverable non-success result; zero interrupted runs leave a false completion marker.
- **SC-007**: `skillwire doctor` correctly classifies 100% of the required diagnostic fixtures and never includes a raw credential, prompt, response, repository hash, or unrelated profile value.
- **SC-008**: Secret-leak scanning finds zero canary credentials across command arguments, process listings, logs, history captures, previews, diffs, client configuration, backups, test artifacts, generated reports, and repository files.
- **SC-009**: First-party-only setup exposes all ten trusted launch skills, completes the smoke journey, and makes zero GitHub requests without a GitHub credential.
- **SC-010**: Default uninstall removes 100% of proven SkillWire-owned client integration state, preserves 100% of seeded unrelated profile state and persistent service data, and supports a duplicate-free reinstall.
- **SC-011**: Permanent removal deletes only the exact separately confirmed SkillWire-owned paths and volumes in 100% of tests and cannot proceed from the default-uninstall confirmation alone.
- **SC-012**: Both no-schema-change and forward-only upgrade suites preserve repository memory, client credentials, and unrelated configuration; 100% of unsafe image-only rollback attempts across migration `010` are refused.
- **SC-013**: Every release candidate passes all Feature 001 through 003 regression suites, all 28 numbered Feature 004 acceptance scenarios, the six-tool contract tests, profile-preservation tests, and secret-disclosure tests before release.
- **SC-014**: In a moderated usability check, at least 90% of supported developers can identify installation state and the next safe recovery action from final setup or doctor output without consulting service internals.
- **SC-015**: 100% of installations that pass deterministic client verification retain that integration when the separate automatic diagnostic observes no invocation, and 100% of autonomous-activation release claims are withheld until the applicable fresh-client evidence meets Feature 003's attributable acceptance target.
- **SC-016**: In every dual-client partial-failure fixture, the verified client and healthy service remain unchanged, the failed client's original profile is restored and its newly created key is revoked, and the command returns the documented incomplete non-success class.
- **SC-017**: In every equivalent pre-existing component fixture, install creates zero duplicates and repair, upgrade, and uninstall produce zero mutations to the reused user-owned component.

## Assumptions

- The target user is an individual developer who controls a supported Linux user account and already has functional access to Docker Engine; Docker installation and daemon administration remain separate explicit choices.
- One local SkillWire account with one distinct onboarding bearer key per selected client preserves shared account-scoped repository memory while allowing independent client rotation, repair, and uninstall; multi-user administration is outside the MVP.
- The normal Codex profile is the user-scoped profile used by the ordinary `codex` command, normally under `~/.codex`; the normal Claude Code profile is the user-scoped profile used by the ordinary `claude` command, normally under `~/.claude` and `~/.claude.json`.
- Vendor-supported plugin and MCP interfaces remain the authority for profile mutation. Direct file mutation is allowed only when the vendor exposes no safer supported operation and planning proves structured atomic preservation for the exact certified format.
- The existing Codex activation plugin remains the Codex adapter baseline. Claude Code receives an equivalent minimal adapter that preserves Feature 003 policy but contains no remote catalog content or executable lifecycle logic.
- The credential bridge is the required MVP transport because direct Codex bearer authentication references an environment variable and does not by itself establish portable secure delivery across terminal, IDE, and desktop launches. Planning still owns the bridge protocol and lifecycle details.
- The ten first-party release skills are sufficient for an immediate smoke journey. Imported sources are optional and do not alter first-party availability.
- Backups and retained uninstall data remain under the local user's responsibility after the tool reports their exact protected locations and restore status.
- Dedicated isolated client profiles may remain available only as an explicitly requested diagnostic or test mode; they are not part of normal onboarding or successful acceptance.
