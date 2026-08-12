# Feature Specification: Autonomous Skill Activation

**Feature Branch**: `003-autonomous-skill-activation`

**Created**: 2026-08-12

**Status**: Draft

**Input**: User description: "Retain portable MCP activation guidance, acknowledge that server instructions alone did not trigger Codex in the validated clean evaluation, and add an optional minimal Codex activation adapter that reliably invokes SkillWire without installing remote skill content or modifying repositories."

## Clarifications

### Session 2026-08-12

- Q: What is the primary autonomous activation mechanism? → A: Standard MCP server-wide `instructions` remain the portable advisory baseline; an optional thin harness adapter is the reliable activation mechanism for harnesses whose server-only behavior has been measured as insufficient.
- Q: May activation install or modify anything in a client environment? → A: Only a versioned activation adapter may be installed once at user scope; no remote skill content or repository-scoped file may be installed or modified.
- Q: How must clients that ignore server instructions behave? → A: Without an adapter they safely omit autonomous activation while normal work and explicit user-requested SkillWire operation remain available.
- Q: When may an agent search autonomously? → A: Once per task intent, only for a non-routine specialized task that could materially benefit from procedural guidance and lacks applicable local or already-loaded guidance.
- Q: How are repeated searches and activation loops bounded? → A: No automatic retry, polling, query reformulation, second skill load, or duplicate resource-path read for an unchanged task intent.
- Q: When may user-requested invocation context be used? → A: Only when explicit intent in the active user task requests the relevant skill or opt-in context; all other agent-initiated searches use automatic context.
- Q: What proves that guidance came from SkillWire rather than a local skill? → A: A successful `load_skill` result containing the exact revision, hash, provenance, and advisory status.
- Q: What constitutes end-to-end activation evidence? → A: Observable MCP traces from clean sessions showing actual initialization, `search_skills`, exact `load_skill`, and declared resource calls where expected; planned or simulated calls are insufficient.
- Q: When may repository memory be created or updated? → A: Usage only during a verified `load_skill` carrying the opaque repository hash; outcomes only for that attributable existing account/repository/revision record.
- Q: What happens when SkillWire is unavailable, unauthorized, rate-limited, or has no relevant result? → A: Fail open with no retry, context escalation, load, memory write, or unrelated result; continue normal work and disclose the limitation only when relevant or explicitly requested.
- Q: What is the client compatibility boundary? → A: Any MCP-capable agent harness may use the same standard behavior; Codex and T3 Code are evaluation targets, while graphical interfaces and harness launchers are outside the system boundary.
- Q: Which user-scope distribution model should the first Codex activation adapter use? → A: A versioned SkillWire Codex plugin installed from a configured SkillWire marketplace and managed through Codex's plugin lifecycle.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discover a Relevant Remote Skill Autonomously (Priority: P1)

As a Codex user who has optionally installed the user-scoped SkillWire activation plugin, I want Codex to recognize when specialized guidance could help, discover a relevant remote skill on its own, and use only the material needed for my task so that I receive the benefit without naming SkillWire or its operations.

**Why this priority**: Autonomous discovery is the feature's central value. Validated clean evidence falsified the assumption that correctly delivered MCP server instructions alone reliably activate the tested Codex harness, so the optional adapter is required before autonomous activation can be claimed for Codex.

**Independent Test**: Start two otherwise identical clean Codex profiles with SkillWire available and no matching local skill: one with server instructions only and one with the versioned activation plugin. Run the same frozen specialized prompts in fresh sessions. Preserve the server-only results as a baseline, and require the adapter cohort to show actual automatic-context search, selection of the relevant preview, exact-revision loading, and only useful declared-resource reads.

**Acceptance Scenarios**:

1. **Given** a clean Codex environment with the activation plugin installed, a specialized task, no equivalent local or already-loaded guidance, and a relevant automatic-eligible catalog entry, **When** Codex decides how to perform the task, **Then** the implicitly invoked adapter directs one automatic-context search without the user mentioning SkillWire, MCP, the adapter, or any operation name.
2. **Given** a relevant search preview, **When** Codex chooses to use the skill, **Then** it loads the exact immutable revision named by that preview before requesting any declared resource.
3. **Given** a loaded skill declares supporting resources and one is useful to the task, **When** Codex needs the additional detail, **Then** it reads only the relevant declared resource and continues the task using the returned inert instructions.
4. **Given** a loaded skill has enough primary instructions to complete the task, **When** its additional resources are not useful, **Then** Codex completes the task without unnecessary resource reads.
5. **Given** only MCP server instructions and no activation adapter, **When** the tested harness does not invoke SkillWire autonomously, **Then** the result is recorded as the server-only baseline rather than a feature success, while normal work and explicit user-requested SkillWire operation remain available.

---

### User Story 2 - Avoid Unnecessary Activation (Priority: P1)

As a Codex user asking a trivial or unrelated question, I want Codex to proceed directly without consulting SkillWire so that routine work stays focused and incurs no needless discovery or loading.

**Why this priority**: Frequent irrelevant activation would undermine trust in autonomous behavior and add noise to ordinary tasks.

**Independent Test**: Run the frozen irrelevant-prompt set in clean profiles and verify that prompts with no credible need for specialized remote guidance do not trigger SkillWire operations, while any zero-relevance search returns no unrelated skills.

**Acceptance Scenarios**:

1. **Given** a greeting, simple calculation, routine text edit, or other trivial task, **When** Codex evaluates the task, **Then** it does not search for or load a remote skill.
2. **Given** a specialized-looking task for which the catalog has no relevant entry, **When** an automatic search occurs, **Then** no unrelated result is returned or loaded.
3. **Given** a task can be completed confidently using ordinary capabilities, **When** no specialized guidance would materially help, **Then** Codex proceeds without a SkillWire call.
4. **Given** an automatic search has already completed for the current task intent, **When** the agent continues, retries, or rephrases internal work without a materially new user objective, **Then** it does not search again, reformulate the query, poll, or load a second candidate.

---

### User Story 3 - Preserve Invocation Isolation (Priority: P1)

As a skill publisher or operator, I want skills classified as user-requested to remain hidden from autonomous discovery and become eligible only after explicit user intent so that sensitive or opt-in guidance is never activated implicitly.

**Why this priority**: Invocation classification is a safety and user-control boundary, not merely a ranking preference.

**Independent Test**: For each frozen user-requested case, run a semantically matching prompt once without explicit intent and once with explicit intent. Verify exclusion in automatic context and eligibility in user-requested context.

**Acceptance Scenarios**:

1. **Given** a matching skill classified as user-requested and no explicit user intent, **When** Codex initiates discovery, **Then** it uses automatic context and the skill remains unavailable.
2. **Given** the user explicitly requests the relevant skill or opt-in context, **When** Codex searches on that request, **Then** it may use user-requested context and the matching skill becomes eligible.
3. **Given** an agent-generated rationale that is not grounded in explicit user intent, **When** Codex searches, **Then** it cannot elevate the request to user-requested context.

---

### User Story 4 - Respect Equivalent Local Skills (Priority: P2)

As a Codex user with an equivalent local skill, I want that local guidance to remain authoritative and free from forced duplicate loading so that SkillWire complements rather than silently displaces my configured environment.

**Why this priority**: Local precedence protects explicit user configuration while still allowing remote discovery to help when there is no equivalent local capability.

**Independent Test**: Run the documented overlap subset with the local skill absent, available, and explicitly selected. Record search and load behavior separately, and verify that SkillWire never forces a duplicate remote load or overrides an explicitly selected local skill.

**Acceptance Scenarios**:

1. **Given** an equivalent local skill is available and sufficient, **When** Codex performs the task, **Then** SkillWire does not force the equivalent remote skill to be loaded.
2. **Given** the user or Codex has explicitly selected a local skill, **When** a remote equivalent also exists, **Then** the remote skill never silently replaces or overrides the selected local skill.
3. **Given** a prompt belongs to the documented local-overlap subset, **When** operators evaluate it, **Then** its activation, selection, and loading results are reported separately from clean-profile results.
4. **Given** guidance was read from a local skill, **When** attribution or repository memory is evaluated, **Then** it is not classified as SkillWire-delivered and creates no SkillWire repository-memory record.

---

### User Story 5 - Evaluate Activation Reproducibly (Priority: P2)

As a SkillWire operator, I want deterministic offline checks and paired version-recorded manual Codex trials so that I can compare server-only and adapter-assisted activation, safety boundaries, and regressions from privacy-safe evidence without requiring live Codex or GitHub credentials in required CI.

**Why this priority**: Autonomous behavior depends partly on an external agent and must be measured repeatably without making required CI nondeterministic or credential-dependent.

**Independent Test**: Validate the frozen corpus, server guidance, adapter package, filtering, workflow, privacy, lifecycle, and regression invariants entirely offline; then execute the same frozen prompts in paired server-only and adapter-assisted clean profiles with a recorded Codex version. Keep the validated `0/7` server-only artifact immutable and calculate adapter metrics from attributable MCP traces.

**Acceptance Scenarios**:

1. **Given** required CI has no live Codex or GitHub credentials, **When** the activation test suite runs, **Then** it deterministically verifies initialization guidance, operation metadata, invocation filtering, workflow and privacy invariants, frozen expected matches, and complete Feature 001 and Feature 002 regression compatibility.
2. **Given** an operator performs a manual release evaluation, **When** the run completes, **Then** separate server-only and adapter-assisted evidence identifies the corpus, catalog, server policy, adapter, Codex product, model, reasoning, environment-profile, and local-skill versions, per-case traces, aggregate metrics, and deviations.
3. **Given** a task has not completed and the user has not explicitly provided outcome feedback, **When** an outcome is considered for recording, **Then** no positive outcome is recorded.
4. **Given** a manual run cannot complete because a live dependency is unavailable, **When** evidence is finalized, **Then** the affected cases are marked incomplete rather than counted as positive outcomes.
5. **Given** a clean end-to-end workflow case, **When** the test completes, **Then** an observable trace proves actual MCP initialization and actual calls to `search_skills`, exact `load_skill`, and `read_skill_resource` where the fixture declares a needed resource; a direct use-case invocation, planned call, or final answer alone is insufficient.

---

### User Story 6 - Manage the Optional Codex Activation Adapter (Priority: P1)

As a Codex user, I want to install, verify, upgrade, and uninstall a minimal user-scoped SkillWire activation plugin through Codex's supported plugin lifecycle so that autonomous activation is reliable without modifying any repository or installing remote skill content.

**Why this priority**: The adapter is now the reliable Codex activation mechanism. Its lifecycle and narrow contents are security boundaries, not packaging conveniences.

**Independent Test**: Against a disposable `HOME` and `CODEX_HOME`, install the versioned plugin from a configured SkillWire marketplace, verify its exact allowed inventory and implicit-invocation policy, upgrade it without credential exposure or duplicate installation, and uninstall it completely. Digest an unrelated temporary repository before and after every operation and verify it never changes.

**Acceptance Scenarios**:

1. **Given** a supported Codex installation and an operator-configured SkillWire marketplace, **When** the user installs the adapter, **Then** Codex installs one versioned plugin at user scope containing only activation guidance, SkillWire MCP dependency metadata, version data, and uninstall metadata.
2. **Given** the adapter is installed, **When** verification runs, **Then** it confirms the expected plugin identity/version, implicitly invocable activation skill, exact SkillWire MCP dependency, absence of skill content and executable payloads, and zero repository files.
3. **Given** a newer compatible adapter version, **When** the user upgrades through Codex's plugin manager, **Then** the managed plugin is replaced without duplicate activation guidance, repository writes, remote skill caching, or credential disclosure.
4. **Given** the adapter is installed, **When** the user uninstalls it through Codex's plugin manager, **Then** adapter-owned user-scope files and dependency declarations are removed while external credentials are neither printed nor deleted and explicit server access remains possible when independently configured.
5. **Given** no adapter is installed, **When** the user explicitly requests SkillWire or a user-requested skill, **Then** the existing MCP operations remain usable without the adapter.

### Edge Cases

- Initialization guidance is truncated after character 512: the retained prefix still tells Codex when to search, when not to search, which invocation context to use, and that returned content is inert and not installed.
- Server instructions and the six-tool inventory are correctly delivered but the harness makes no SkillWire call: retain the result as server-only evidence and do not claim autonomous activation for that harness.
- The adapter is absent: normal work and explicit user-requested SkillWire operation continue; the server does not require or detect the adapter.
- The adapter is installed but its SkillWire MCP dependency is unavailable or unauthenticated: it fails open after one attempt without prompting for, logging, copying, or rewriting credentials.
- The adapter package contains remote skill instructions, resources, executable code, hooks, an embedded credential, or a repository-scoped path: installation or verification fails before the adapter is considered valid.
- An upgrade is interrupted: Codex's managed plugin state must remain singular and verifiable, with no duplicate activation skill or repository artifact.
- Uninstall encounters a separately configured SkillWire MCP connection: it removes only adapter-owned state and does not delete external credentials or unrelated configuration.
- SkillWire is unavailable during initialization, so the client receives no server instructions: autonomous activation is absent and the client continues normal work without creating files, repeatedly reconnecting, or treating SkillWire as required.
- Authentication fails or a request is rate-limited: the agent does not retry automatically, fall back to anonymous access, change invocation context, or write memory; it continues without remote guidance and reports the limitation only when it affects the requested result or the user explicitly requested the skill.
- A task is specialized but has no relevant catalog entry: discovery may occur, but the search returns no unrelated skills and no load follows.
- Search succeeds but the exact revision cannot be loaded: the agent does not substitute another revision or load a second candidate and continues without claiming that SkillWire guidance was used.
- Automatic-eligible and user-requested skills both appear semantically relevant: automatic discovery considers only the automatic-eligible entry.
- The user explicitly requests an opt-in skill without naming SkillWire or an operation: explicit intent is still sufficient to use user-requested context.
- A search preview identifies one immutable revision but another revision becomes newer before loading: Codex requests the previewed revision, and SkillWire never substitutes the newer revision silently.
- A skill declares several resources but none are necessary: no resource is read merely because it exists.
- A requested resource is undeclared, unsafe, unavailable, or fails integrity validation: the existing safe failure behavior is preserved, the task does not treat missing content as successfully loaded guidance, and no recovery outcome or additional usage is recorded; an attributable usage record already created by the preceding verified load remains valid.
- A declared resource path has already been read during the unchanged task intent: the agent uses the content already in context and does not read the same path again.
- Repository memory is absent or no opaque repository hash is provided: discovery and loading still work without repository-specific memory.
- Repository memory is requested with a raw path, repository contents, or another non-opaque identifier: the request is rejected under existing privacy guarantees.
- Search metadata or a local skill happens to use the same skill name: neither is evidence of SkillWire delivery; only the successful provenance-bearing exact load is attributable.
- An equivalent local skill exists but equivalence is ambiguous: the evaluation records the case's declared overlap classification and reports it separately rather than inferring a favorable result after the run.
- A positive outcome is proposed based only on a search, load, or partial task: it is not recorded without completed-task evidence or explicit user feedback.
- A manual evaluation is rerun with a different Codex, catalog, corpus, or local-skill version: the run is recorded as a distinct evidence set rather than merged invisibly with earlier results.
- Adapter-assisted evidence is produced without an attributable `search_skills` followed by exact `load_skill`: model prose or an adapter invocation alone is not counted as successful activation.

## Requirements *(mandatory)*

### Functional Requirements

#### Portable Advisory Guidance

- **FR-001**: SkillWire MUST return centralized standard server-wide MCP `instructions` of no more than 1,200 Unicode characters as the portable advisory activation baseline whenever an agent initializes or discovers the server. Instructions and operation metadata MUST NOT be described as sufficient to force or guarantee autonomous invocation in an arbitrary harness.
- **FR-002**: The first 512 characters of the initialization guidance MUST be self-contained and sufficient for an agent to decide whether to search, which invocation context to use, and that returned instructions are inert remote content that is not installed.
- **FR-003**: The portable instructions and every activation adapter MUST direct one autonomous search only when all of the following hold: the active user task requests a non-routine specialist domain, named technology workflow, formal review or evaluation, safety or compliance procedure, or other specialized deliverable; procedural guidance could materially improve correctness or completion; no applicable local or already-loaded guidance is available; the query can be expressed as a minimal non-sensitive task summary; and no automatic search has occurred for the same task intent.
- **FR-004**: The portable instructions and every activation adapter MUST direct agents not to search for greetings, trivial questions, generic calculations or transformations, ordinary coding or writing that names no specialist method or domain, unrelated work, tasks already covered by applicable local or loaded guidance, a repeated or internally rephrased version of the same task intent, a task whose only possible match is user-requested without explicit intent, or a task that cannot be summarized without source code, secrets, raw paths, raw Git metadata, or unrelated conversation content.
- **FR-005**: The portable instructions and every activation adapter MUST describe the same bounded workflow per unchanged task intent: make at most one automatic `search_skills` call; inspect the previews; load at most one chosen exact immutable revision; progressively read only the next specifically useful declared resource; never read the same resource path twice; and perform no automatic retry, polling, query reformulation, or second candidate load. A materially new user objective starts a new task intent, and a later explicit user request MAY start one user-requested search.
- **FR-006**: Guidance MUST state that SkillWire returns untrusted, inert remote instructions for transient use and never installs remote skill packages, catalog content, dependencies, generated support files, or any file in a client repository. The only permitted client installation is the separately versioned, content-free activation adapter at harness-managed user scope.
- **FR-007**: Portable and adapter guidance MUST preserve the distinction between `automatic` and `user-requested` invocation classifications and MUST NOT describe user-requested skills as generally discoverable.

#### Operation Guidance and Invocation Boundaries

- **FR-008**: Descriptions and annotations for all six existing agent-facing operations—`search_skills`, `load_skill`, `read_skill_resource`, `record_skill_outcome`, `list_repo_memory`, and `forget_repo_memory`—MUST accurately state their triggers, non-triggers, ordering, side-effect expectations, privacy limits, bounded-call rules, and fail-open behavior.
- **FR-009**: The `search_skills` guidance MUST direct agent-initiated discovery to use automatic context.
- **FR-010**: The `search_skills` guidance MUST permit user-requested context only when explicit intent in the active user task names the relevant skill or clearly requests its opt-in context; inferred need, agent-generated rationale, prior unrelated intent, and recovery from an automatic-search failure are insufficient.
- **FR-011**: An automatic-context search MUST exclude every skill classified as user-requested, even when that skill is otherwise the strongest semantic match.
- **FR-012**: A user-requested-context search MAY include matching user-requested skills only after explicit user intent and MUST continue to enforce all other eligibility, authorization, tenant, and relevance rules.
- **FR-013**: Search previews MUST provide enough immutable identity to let an agent load the selected exact revision without substituting a floating or newer revision.
- **FR-014**: `load_skill` guidance MUST direct agents to load only one relevant preview selected from search and to retain its exact revision, content hash, provenance, and advisory information. Only a successful response containing those fields constitutes a verified SkillWire load or proves that guidance was SkillWire-delivered; matching names, search previews, local files, and local skills do not.
- **FR-015**: `read_skill_resource` guidance MUST direct agents to request only the next specifically needed safe, declared resource from the already-loaded exact revision, never bulk-read a manifest, never request the same path twice for an unchanged task intent, and stop when enough guidance is in context.
- **FR-016**: `record_skill_outcome` guidance and behavior MUST prohibit a positive outcome unless supported by evidence from the completed task or explicit user feedback.
- **FR-017**: Repository memory MUST remain optional and attributable: only a verified `load_skill` carrying the existing opaque repository hash may create or increment usage for its exact authenticated-account, repository-hash, skill, and revision scope; `record_skill_outcome` may update only that existing record; searches, resource reads, failed loads, and local-skill use MUST NOT create memory. Raw repository paths, contents, prompts, secrets, and Git metadata remain prohibited.
- **FR-018**: The SkillWire server and remote skill-delivery protocol MUST remain client-agnostic and usable by any MCP-capable harness through the same standard instructions and six operations. Optional adapters MUST remain thin, separately packaged harness integrations outside the protocol-independent server core; no adapter may alter an MCP operation contract, become mandatory for explicit operation, or require repository-specific configuration. Graphical interfaces and launchers remain outside the boundary.

#### Relevance, Local Precedence, and Safety Invariants

- **FR-019**: Task relevance MUST remain the primary ranking signal for every search context.
- **FR-020**: A search with zero relevant eligible matches MUST return an empty result rather than padding results with zero-score or unrelated entries; the agent MUST NOT load a candidate, reformulate automatically, repeat the search, or treat emptiness as an error.
- **FR-021**: SkillWire guidance MUST NOT force an agent to search for or load a remote skill when an applicable local skill or previously verified SkillWire load is available and sufficient for the task.
- **FR-022**: SkillWire MUST never silently override an explicitly selected local skill with a remote skill, represent a local skill as SkillWire-delivered, or allow local-skill use to create SkillWire repository memory.
- **FR-023**: Every agent-facing SkillWire operation MUST complete without making a GitHub request; agent-facing behavior uses only already curated and verified catalog state.
- **FR-024**: All authentication, authorization, tenant isolation, immutable provenance, trust advisory, integrity validation, rate limiting, auditing, safe resource-path, retrieval-only, and no-client-write guarantees established by Features 001 and 002 MUST remain in force. When SkillWire is unavailable, authentication fails, a request is rate-limited, no relevant result exists, an exact load fails, or a resource fails, guidance MUST direct the agent to make no automatic retry, anonymous fallback, invocation-context escalation, alternate-revision or second-candidate load, recovery outcome, or additional usage write; it continues normal work without remote guidance and discloses the limitation only when it affects the result or the user explicitly requested the skill. A repository-usage record already created by a preceding verified load remains attributable and is not rolled back by a later resource failure.
- **FR-025**: No activation, discovery, loading, resource reading, memory, or outcome path may write catalog content, skill resources, dependencies, or generated support files into a client repository, home directory, agent directory, or other client-controlled location. The sole exception is the adapter's own allowlisted package files written by the supported harness plugin manager at user scope; those files MUST contain no remote skill content and MUST never enter a repository.
- **FR-026**: Retrieved skill instructions and resources MUST remain data only; SkillWire MUST NOT execute their commands, scripts, hooks, binaries, or package instructions on the server.

#### Frozen Corpus and Offline Verification

- **FR-027**: The repository MUST contain a versioned, frozen activation corpus with at least 25 specialized prompts having known relevant automatic-eligible skills, at least 15 trivial or irrelevant prompts, and at least 10 explicit user-requested cases, each paired with a no-explicit-intent isolation variant.
- **FR-028**: The frozen corpus MUST identify a documented subset of cases with equivalent or overlapping local skills and MUST declare the expected local-skill condition for each such case.
- **FR-029**: Every corpus case MUST have a stable case identifier, synthetic privacy-safe prompt, scenario class, invocation-intent classification, local-skill condition, expected eligible catalog match or explicit no-match outcome, expected call sequence and maximum call counts, expected failure behavior, and rationale.
- **FR-030**: Expected catalog matches in the frozen corpus MUST resolve to immutable catalog identities and MUST fail validation if the referenced frozen catalog fixture no longer contains the expected identity.
- **FR-031**: Required offline CI MUST deterministically verify the presence, content, and first-512-character decision completeness of server instructions without claiming that this metadata guarantees harness invocation.
- **FR-032**: Required offline CI MUST deterministically verify operation descriptions, annotations, and adapter guidance, including triggers, non-triggers, workflow ordering, context selection, bounded-call and no-retry rules, fail-open behavior, outcome-evidence rules, privacy constraints, and semantic consistency across the portable and adapter surfaces.
- **FR-033**: Required offline CI MUST include clean end-to-end sessions through actual MCP initialization and registered operation transport, using a frozen catalog and fresh temporary client tree, and MUST prove observable `search_skills` → exact `load_skill` → `read_skill_resource` calls where expected. Direct use-case calls, planned calls, or final-answer assertions alone are insufficient. These sessions MUST also verify automatic versus user-requested filtering, relevance-first ranking, zero-relevance empty results, maximum call counts, progressive declared-resource access, verified-load-only opaque-hash memory, failure behavior, no GitHub requests, and zero client-tree writes.
- **FR-034**: Required offline CI MUST validate the frozen evaluation schema, minimum corpus composition, overlap subset, and expected catalog matches.
- **FR-035**: Required offline CI MUST run the complete required regression suites for Features 001 and 002 and MUST treat any regression failure as a Feature 003 release failure.
- **FR-036**: Required CI MUST NOT invoke live Codex or GitHub services and MUST NOT require credentials for either service.

#### Manual Release Evaluation

- **FR-037**: The project MUST provide a repeatable paired manual evaluation protocol that runs each applicable frozen case in fresh, otherwise identical Codex sessions under two separately reported conditions: server instructions only and server instructions plus the versioned activation adapter. Sessions MUST have no matching local skills or prior SkillWire context, and prompts MUST not mention SkillWire, MCP, the adapter, or operation names except where a case explicitly tests user-requested intent. Evidence MUST use observable MCP traces rather than final-answer inference.
- **FR-038**: Each manual cohort MUST measure spontaneous search activation, correct skill selection after search, exact-revision loading, progressive resource reading, unnecessary activation, user-requested isolation, and behavior with equivalent local skills; only the adapter cohort is eligible to satisfy the autonomous-activation acceptance target.
- **FR-039**: Clean-profile and local-overlap results MUST be measured and reported separately; overlap cases MUST distinguish search from duplicate remote loading and from silent local-skill override.
- **FR-040**: Each manual evidence set MUST record the evaluation protocol, corpus, frozen catalog, server policy, adapter presence and version, Codex product, model, reasoning setting, run date, environment profile, effective MCP/skill inventory condition, and per-case observable trace outcomes.
- **FR-041**: Manual evidence MUST contain only synthetic corpus prompts, stable identifiers, version metadata, operation names, immutable skill identities, categorical outcomes, counts, and redacted diagnostics; it MUST NOT contain private source code, raw repository paths, secrets, raw Git metadata, or unrelated conversation content.
- **FR-042**: Aggregate results MUST use documented denominators and MUST mark incomplete or externally blocked cases separately; incomplete cases and searches or loads without completed-task evidence MUST NOT be counted as successful outcomes.
- **FR-043**: Live evaluation evidence MAY support release decisions but MUST remain outside required CI and MUST be reproducible without changing the frozen corpus or retroactively changing expected results. The validated server-only `0/7` evidence MUST remain preserved as an immutable baseline and MUST NOT be overwritten, relabeled as adapter evidence, or reinterpreted as successful activation.

#### Optional Harness Activation Adapter

- **FR-044**: The first adapter MUST be a versioned Codex plugin distributed through a configured SkillWire marketplace and installed, upgraded, or uninstalled only through Codex's supported user-scoped plugin lifecycle.
- **FR-045**: The Codex plugin MUST bundle exactly one activation skill whose concise description permits implicit invocation for specialized tasks and whose instructions reproduce the server's automatic/user-requested, local-precedence, one-attempt, progressive-load, privacy, attribution, and fail-open policy without embedding any remote skill instructions.
- **FR-046**: The adapter package MAY contain only the plugin manifest needed to express activation guidance, SkillWire MCP dependency metadata, version information, and uninstall metadata. It MUST NOT contain catalog entries, remote skill instructions or resources, executable scripts or binaries, hooks, generated task support files, repository paths, credentials, tokens, or credential values.
- **FR-047**: Adapter MCP metadata MUST identify only the existing SkillWire MCP dependency and the protected credential reference expected by Codex. Installation, verification, upgrade, diagnostics, and uninstall MUST never print, persist in repository files, or copy credential values into the adapter package.
- **FR-048**: Adapter installation and verification MUST fail safely when the package identity, version, allowlisted inventory, implicit-invocation setting, or MCP dependency metadata is missing or unexpected. Verification MUST prove that no repository file changed and no remote skill content was materialized locally.
- **FR-049**: Adapter upgrade MUST preserve a single managed plugin identity, replace the prior adapter version without duplicate activation guidance, retain no obsolete adapter-owned files, and leave external SkillWire credentials and unrelated harness configuration unchanged.
- **FR-050**: Adapter uninstall MUST remove only adapter-owned user-scope plugin files and dependency declarations, leave repositories and remote skill content untouched, avoid printing or deleting external credentials, and restore the server-only condition in which explicit user-requested operation remains possible.
- **FR-051**: The adapter MUST NOT implement search, ranking, loading, resource retrieval, provenance, advisory, integrity, authentication, tenancy, memory, or outcome behavior itself. It may only guide the harness to invoke the unchanged SkillWire MCP operations and must treat their responses as authoritative.
- **FR-052**: Required offline CI MUST validate the adapter manifest and exact file inventory, reject forbidden payloads and repository paths, verify lifecycle operations against disposable user-scope directories, assert zero repository writes and zero credential disclosure, and keep these deterministic checks independent of live Codex/model activation measurements.
- **FR-053**: A successful adapter-assisted activation MUST be attributable only when observer or server-side evidence records `search_skills` followed by `load_skill` for the exact previewed revision and any expected declared `read_skill_resource` call. Invocation of the adapter skill, tool availability, or model prose alone is insufficient.

### Key Entities

- **Activation Guidance**: The server-wide decision aid presented at initialization. Its key attributes are version, full text, self-contained 512-character prefix, search triggers, non-triggers, invocation-context rule, ordered workflow, and inert/no-install statement.
- **Harness Activation Adapter**: An optional, versioned, content-free user-scoped package that maps the portable activation policy onto a harness's supported implicit-invocation mechanism. It guides calls to SkillWire but owns no remote skill, catalog, credential, ranking, retrieval, or repository state.
- **Codex Activation Plugin**: The first harness adapter, distributed from a configured SkillWire marketplace. It contains one implicitly invocable activation skill plus only allowlisted MCP dependency, version, and uninstall metadata.
- **Operation Guidance**: User-visible descriptions and annotations for one of the six existing operations. It captures intended trigger, prohibited trigger, workflow position, privacy boundary, and side-effect expectations without changing the operation's request or response contract.
- **Task Intent**: The active user objective used to bound one autonomous activation attempt. Agent substeps, retries, and internal query rephrasing do not create a new task intent; a materially new user objective does.
- **Invocation Context**: The search eligibility boundary, either automatic or user-requested, together with the explicit-intent evidence required for the latter.
- **Verified SkillWire Load**: A successful `load_skill` response for an exact revision that includes its content hash, published provenance, and current advisory status. It is the sole evidence that guidance was SkillWire-delivered and the only operation allowed to create attributable repository usage memory.
- **Activation Corpus Case**: A frozen synthetic task and its stable expectations, including scenario class, expected eligibility or no-match result, local-skill condition, workflow boundaries, and rationale.
- **Local Overlap Declaration**: The versioned assertion that a named corpus case has no local match, an equivalent local skill, or a partially overlapping local skill. It allows overlap behavior to be evaluated separately and consistently.
- **Manual Evaluation Run**: A version-recorded collection of per-case observable outcomes and aggregate metrics tied to one Codex version, corpus version, catalog version, environment profile, and local-skill condition.
- **Activation Cohort**: One manual-evaluation condition, either `server-only` or `server-plus-adapter`. Cohorts use the same frozen prompts and pinned harness/model settings but are never merged or relabeled.
- **Outcome Evidence**: Evidence from a completed task or explicit user feedback that can justify an outcome record; discovery, loading, or partial progress alone is insufficient for a positive result.

### Scope Boundaries

This feature retains standard server-side MCP activation instructions, metadata for the six existing operations, validation of their existing fields, deterministic evaluation fixtures, and release evidence. It additionally permits thin optional harness adapters outside the protocol-independent server core. The first adapter is a user-scoped Codex plugin containing activation guidance and dependency metadata only. Any MCP-capable harness may still consume the same server behavior without an adapter, and explicit user-requested operation remains available when an adapter is absent.

The following remain out of scope:

- Database migrations, semantic embeddings, or vector storage
- Dashboards, hosted deployment, or a client-side repository agent
- Graphical interfaces, harness launchers, or adapters other than the first minimal Codex activation plugin
- New GitHub discovery behavior, automatic source curation, or any GitHub access from agent-facing operations
- Local installation of remote skill content, repository-scoped activation files, or client-tree writes outside the allowlisted user-scoped adapter package
- New MCP operations or contract changes beyond server instructions, descriptions, and annotations

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the version-recorded server-plus-adapter clean-profile evaluation, at least 80% of the 25 or more relevant specialized prompts cause one spontaneous automatic-context search without mentioning SkillWire, MCP, the adapter, or operation names. No autonomous-activation claim may be made from server-only instructions unless separately measured evidence meets the same target.
- **SC-002**: Among adapter-cohort clean-profile cases where a search occurs and the frozen corpus declares a relevant match, at least 90% load the expected exact relevant skill revision.
- **SC-003**: No more than 10% of the 15 or more trivial or irrelevant adapter-cohort prompts cause any SkillWire operation.
- **SC-004**: In both evaluation conditions, all user-requested cases enforce isolation: 100% exclude the opt-in skill without explicit intent, and 100% make it eligible when the corresponding explicit intent is present and all other eligibility rules pass.
- **SC-005**: Every autonomous activation trace contains no more than one search and one exact immutable skill load for an unchanged task intent; every load is the revision selected from its preview, with zero retries, query reformulations, second-candidate loads, or silent substitutions.
- **SC-006**: Every observed resource read follows a verified exact skill load, targets the next specifically useful declared safe resource, and reads each path no more than once per unchanged task intent; no manifest is bulk-read and no resource is read merely because it is available.
- **SC-007**: In all explicitly selected local-skill cases, there are zero silent remote overrides and zero forced duplicate remote loads; search and load behavior for the entire overlap subset is reported separately.
- **SC-008**: Required offline verification passes 100% of initialization, operation metadata, adapter inventory and lifecycle, actual transported call-sequence, invocation filtering, ranking, workflow, failure, privacy, frozen-corpus, and Feature 001/002 regression checks without live service credentials.
- **SC-009**: Agent-facing activation and evaluation produce zero GitHub requests, zero repository writes, zero local remote-skill-content writes, zero repository-memory records without a verified exact load, and zero automatic retries after unavailability, authentication failure, rate limiting, no relevant result, exact-load failure, or resource failure. User-scope writes are limited to the allowlisted adapter package during its explicit lifecycle.
- **SC-010**: 100% of positive recorded outcomes are backed by completed-task evidence or explicit user feedback; partial, incomplete, and externally blocked cases contribute zero positive outcomes.
- **SC-011**: An evaluator can reproduce the published metric calculations from the versioned corpus and privacy-safe per-case evidence using the documented denominators, with no access to private repositories or raw user conversations.
- **SC-012**: The first 512 characters of initialization guidance independently pass every documented advisory tool-selection decision check even when the remaining guidance is unavailable; this is a metadata-quality result, not an autonomous-invocation guarantee.
- **SC-013**: The validated server-only baseline remains reproducible and unchanged at `0/7` completed spontaneous activations for Codex CLI `0.147.0`, `gpt-5.6-sol`, and `xhigh`; it is reported separately and never counted toward adapter acceptance.
- **SC-014**: Adapter install, verify, upgrade, and uninstall tests produce zero credential disclosure, zero repository changes, zero remote skill content on disk, exactly one managed adapter identity while installed, and zero adapter-owned files after uninstall.
- **SC-015**: 100% of successful adapter-assisted activation observations contain attributable ordered MCP evidence for `search_skills` followed by the expected exact `load_skill`, plus each fixture-required declared resource read; adapter invocation or final-answer text alone contributes zero successes.

## Assumptions

- The current six agent-facing operations and their request and response contracts remain the baseline established by Features 001 and 002.
- The existing catalog contains enough curated immutable fixtures to support the minimum frozen corpus; corpus prompts are synthetic and do not copy private user tasks.
- A "clean Codex environment" means SkillWire is configured and reachable, no matching local skill is available, no prior task context reveals the expected skill, and the user has not mentioned SkillWire, MCP, the adapter, or operation names. The adapter cohort differs only by the pinned user-scoped activation plugin.
- MCP-capable harnesses can expose standard server instructions and observable operations without an adapter, but the validated Codex evidence shows that correct exposure alone does not reliably cause autonomous invocation in that harness. The server remains portable; Codex-specific reliability is supplied only by the optional plugin.
- "Explicit user intent" may name the relevant skill or clearly request the opt-in context; merely being relevant to an agent's inferred plan is not explicit intent.
- Local-skill equivalence and partial overlap are declared before evaluation and versioned with the corpus, rather than inferred after observing results.
- Spontaneous activation is influenced by Codex behavior, so paired live measurements remain non-blocking release evidence rather than deterministic required-CI gates. The adapter cohort must nevertheless meet the acceptance targets before documentation or release material claims autonomous Codex activation.
- Codex's supported plugin manager is available for user-scoped install, upgrade, disable, and uninstall, and a configured SkillWire marketplace is the distribution source; the feature does not create a custom installer or launcher.
- Repository memory is absent by default in clean-profile trials and is tested separately only with the existing opaque repository hash.
- Existing authentication, authorization, tenant isolation, provenance, advisory, integrity, rate-limit, audit, and safe-resource controls are dependencies and cannot be weakened by this feature.
- Feature 001 and Feature 002 artifacts remain closed and unchanged; regression compatibility is established by running their existing required tests, not by editing their specifications or contracts.
