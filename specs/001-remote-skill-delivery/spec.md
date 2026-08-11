# Feature Specification: Remote Skill Delivery MVP

**Feature Branch**: `master`

**Created**: 2026-08-11

**Status**: Draft

**Input**: User description: "Build the first MVP of SkillWire as an independent,
MCP-compatible service for just-in-time discovery and retrieval of curated remote skills,
progressive textual resources, immutable provenance, and private repository-scoped usage memory."

## Clarifications

### Session 2026-08-11

- Q: What exact format must clients use for the opaque repository hash? → A: Exactly 64 lowercase
  hexadecimal characters representing a client-generated SHA-256 digest.
- Q: What content must the revision-level SHA-256 hash cover? → A: The Markdown instructions,
  canonical resource manifest, and every declared resource, with an additional SHA-256 hash for
  each resource.
- Q: How should a recorded outcome affect the limited repository-specific ranking boost? → A:
  Useful gets the larger limited boost, neutral or unrated gets a smaller boost, and unsuccessful
  gets no boost; task relevance remains primary.
- Q: What authorization scope should each bearer API key have? → A: Each key maps to one account and
  may use all six operations for every repository hash in that account.
- Q: When an allowlisted skill source is unavailable, should SkillWire serve an already cached exact
  revision? → A: Yes, but only after verifying the complete cached bundle hash and applying normal
  authentication, validation, provenance, and audit rules.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discover Relevant Skills (Priority: P1)

An authenticated AI agent describes a task in natural language and receives a compact, ranked list
of relevant skills from the curated catalog. The agent can decide whether a skill is worth loading
without receiving complete skill instructions or resource content.

**Why this priority**: Discovery is the entry point to SkillWire and delivers immediate value by
making remote skills findable without polluting the client environment.

**Independent Test**: Submit representative task descriptions to `search_skills` and verify that
the response contains ranked previews only, including enough identity and revision information to
select a skill, while excluding full instructions and resources.

**Acceptance Scenarios**:

1. **Given** a catalog containing relevant skills, **When** an authenticated agent submits a
   natural-language task description, **Then** it receives compact previews ordered by relevance.
2. **Given** a matching skill with full instructions and resources, **When** it appears in search,
   **Then** the preview does not contain the full instructions or any resource body.
3. **Given** no repository hash, **When** the agent searches, **Then** search succeeds and no
   repository memory is created.
4. **Given** no relevant catalog entry, **When** the agent searches, **Then** it receives an empty
   result rather than content fetched from an uncurated source.
5. **Given** comparably relevant skills and repository memory for the supplied account and hash,
   **When** the agent searches, **Then** useful prior usage receives the larger limited boost,
   neutral or unrated usage receives a smaller boost, unsuccessful usage receives no boost, and an
   irrelevant skill does not outrank a relevant skill.

---

### User Story 2 - Load a Verifiable Skill Revision (Priority: P2)

After choosing a preview, an authenticated agent loads one exact immutable skill revision and
receives its Markdown instructions together with source, revision, SHA-256 content hash, trust
status, and declared resource manifest.

**Why this priority**: Loading turns discovery into usable guidance while preserving reproducibility
and a verifiable chain of provenance.

**Independent Test**: Load a known catalog skill by its exact identity and revision, verify every
provenance field and the content hash, and confirm that repeating the load returns identical content
and metadata.

**Acceptance Scenarios**:

1. **Given** a valid catalog skill and exact revision, **When** the agent calls `load_skill`, **Then**
   it receives the Markdown instructions and complete provenance and resource-manifest metadata.
2. **Given** the same published revision, **When** it is loaded repeatedly, **Then** the returned
   content, hash, trust status, and manifest remain identical.
3. **Given** an unknown or non-exact revision, **When** the agent attempts to load it, **Then** the
   request is rejected without substituting another revision.
4. **Given** a monitored client repository, **When** search and load operations complete or fail,
   **Then** no catalog content, package, script, dependency, or other file is created or modified in
   the client environment.
5. **Given** skill text containing commands or code examples, **When** SkillWire loads it, **Then**
   the content is returned only as text and nothing from it is executed.
6. **Given** an unavailable allowlisted source and a previously verified cached copy of the requested
   exact revision, **When** the agent loads it, **Then** SkillWire re-verifies the complete bundle
   hash and returns it under the normal authentication, validation, provenance, and audit rules.
7. **Given** an unavailable allowlisted source and no valid cached copy of the requested exact
   revision, **When** the agent loads it, **Then** the request fails safely as unavailable without
   substituting another revision.

---

### User Story 3 - Read Resources Progressively (Priority: P3)

An authenticated agent inspects the loaded revision's resource manifest and retrieves only the
declared textual resource it currently needs, without downloading unrelated resources.

**Why this priority**: Progressive retrieval keeps responses compact and gives the agent control
over when additional context is consumed.

**Independent Test**: Load a revision with multiple declared resources, request one manifest path
through `read_skill_resource`, and verify that only that resource is returned and unsafe or
undeclared paths are rejected.

**Acceptance Scenarios**:

1. **Given** a loaded revision with multiple declared resources, **When** the agent requests one
   valid resource path, **Then** it receives only that resource's textual content.
2. **Given** an absolute path, traversal path, undeclared path, or resource belonging to another
   revision, **When** the agent requests it, **Then** the request is rejected safely.
3. **Given** a document or resource exceeding the configured content limit, **When** retrieval is
   attempted, **Then** the content is rejected and no partial unsafe content is returned.
4. **Given** a caller-supplied URL in place of a catalog identity or resource path, **When** the
   request is made, **Then** SkillWire rejects it and does not fetch the URL.

---

### User Story 4 - Recall Repository Skill Usage (Priority: P4)

An authenticated agent may attach an opaque, client-generated repository hash when loading a skill.
The repository hash is the repository fingerprint required by the constitution. The agent can later
discover which exact skill revisions were used for that same repository, while other repositories
and accounts remain isolated.

**Why this priority**: Repository-scoped memory helps agents reuse relevant prior skills without
storing source code or identifiable repository data.

**Independent Test**: Load a known revision with repository hash A, restart the service, and verify
that `list_repo_memory` returns it for the same account and hash but not for repository hash B or
another account.

**Acceptance Scenarios**:

1. **Given** an authenticated account and repository hash A, **When** a skill is loaded with that
   hash, **Then** its exact identity and revision appear in A's repository memory.
2. **Given** a load recorded for repository A, **When** the same account lists repository B's
   memory, **Then** A's record is not exposed.
3. **Given** two authenticated accounts using the same repository hash value, **When** either lists
   memory, **Then** each sees only its own records.
4. **Given** stored repository memory, **When** the service restarts, **Then** the same authenticated
   account can still inspect that memory.
5. **Given** a load without a repository hash, **When** repository memory is later listed, **Then**
   the hash-free load does not appear in any repository memory.

---

### User Story 5 - Record Outcomes and Erase Memory (Priority: P5)

An authenticated agent records whether a previously loaded skill revision was useful, neutral, or
unsuccessful. It can inspect that result and erase all memory for the repository when requested.

**Why this priority**: Explicit outcomes make memory meaningful, while inspection and complete
erasure keep that memory under the account owner's control.

**Independent Test**: Seed one repository load, record each supported outcome in turn, verify the
latest value through `list_repo_memory`, invoke `forget_repo_memory`, and verify that no record
remains after a restart.

**Acceptance Scenarios**:

1. **Given** a skill revision previously loaded for a repository, **When** the agent records a
   useful, neutral, or unsuccessful outcome, **Then** that outcome is visible in the repository's
   inspectable memory.
2. **Given** an unsupported outcome or a skill revision not previously loaded for that repository,
   **When** the agent records an outcome, **Then** the request is rejected without changing memory.
3. **Given** repository memory containing loads and outcomes, **When** the account invokes
   `forget_repo_memory`, **Then** all memory for that account and repository hash is removed
   completely.
4. **Given** erased memory, **When** the service restarts and the account lists that repository hash,
   **Then** no erased load or outcome reappears.
5. **Given** an unauthenticated caller or a different account, **When** it attempts to inspect,
   update, or erase the repository memory, **Then** access is rejected without revealing whether
   the target memory exists.

### Edge Cases

- Empty, whitespace-only, malformed, or oversized task descriptions are rejected without searching
  or persisting their content.
- Duplicate catalog matches are represented once per exact skill revision in search results.
- An unknown skill identifier or revision is rejected rather than resolved to a fallback revision.
- A published revision whose retrieved content no longer matches its recorded hash is unavailable
  until the integrity failure is resolved; mismatched content is never returned.
- An unavailable allowlisted source falls back only to a complete cached copy of the requested exact
  revision whose bundle hash can be re-verified; missing, incomplete, or mismatched cache entries
  produce a safe unavailable response.
- Absolute paths, path traversal, encoded traversal, undeclared paths, non-text resources, and
  oversized resources are rejected.
- A missing repository hash means memory is disabled for that request; a malformed hash is rejected
  rather than normalized from raw repository data.
- The same opaque repository hash under two accounts forms two isolated memory scopes.
- Repeated loads of the same revision in one repository remain discoverable as one usage record and
  do not create unbounded duplicates.
- Repeated erasure of an already-empty repository scope succeeds without revealing prior existence.
- Rate-limited and unauthorized requests return safe errors and do not mutate catalog or memory
  state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The MVP MUST expose `search_skills`, `load_skill`, `read_skill_resource`,
  `list_repo_memory`, `record_skill_outcome`, and `forget_repo_memory` as its agent-facing MCP
  operations.
- **FR-002**: Every operation MUST require a bearer API key that authenticates exactly one account
  before processing the request or accessing account-scoped data. Each valid key MUST authorize all
  six MVP operations across every repository hash in that account and MUST NOT authorize access to
  any other account.
- **FR-003**: The catalog MUST contain approximately ten curated, trusted, text-only skills at
  launch; the accepted launch range is eight to twelve skills.
- **FR-004**: Catalog source locations and revisions MUST be restricted to an operator-curated
  allowlist, and callers MUST NOT be able to submit a URL or arbitrary fetch target.
- **FR-005**: SkillWire MUST return catalog content only through operation responses and MUST NOT
  install or write skills, packages, scripts, binaries, dependencies, or resources into any client
  repository, user directory, skill directory, package directory, or agent harness.
- **FR-006**: SkillWire MUST treat every skill document and resource as untrusted text and MUST NOT
  execute, invoke, import, compile, or install content obtained from a skill source.
- **FR-007**: `search_skills` MUST accept a natural-language task description and an optional opaque,
  client-generated repository hash.
- **FR-008**: `search_skills` MUST rank catalog matches primarily by relevance to the supplied task
  description and MUST return the most relevant match first. Prior usage from the same authenticated
  account and repository hash MUST provide only a limited secondary boost: useful usage receives
  the larger boost, neutral or unrated usage receives a smaller boost, and unsuccessful usage
  receives no boost. Memory MUST NOT allow a less relevant skill to outrank a clearly relevant
  skill.
- **FR-009**: Each search result MUST be a compact preview containing a stable skill identifier,
  name, concise description, matching capability summary, trust status, and an exact immutable
  revision identifier suitable for `load_skill`.
- **FR-010**: Search previews MUST NOT contain complete skill instructions or resource bodies.
- **FR-011**: `load_skill` MUST require a stable skill identifier and exact immutable revision; it
  MUST NOT silently select a different or floating revision.
- **FR-012**: A successful load MUST return the complete validated Markdown instructions, source,
  immutable revision, revision-level SHA-256 hash, trust status, and complete declared resource
  manifest. The revision hash MUST cover the Markdown instructions, canonical manifest, and every
  declared resource, and each manifest entry MUST include that resource's SHA-256 hash.
- **FR-013**: A published revision MUST always resolve to identical validated content and manifest;
  changed content MUST be published as a new revision with a new content hash.
- **FR-014**: SkillWire MUST verify the complete revision bundle against its published SHA-256 hash
  before returning skill content and MUST verify each resource against its manifest hash before
  returning that resource. If the allowlisted source is unavailable, SkillWire MUST serve only a
  complete cached copy of the requested exact revision after re-verifying its bundle hash and
  applying the same authentication, validation, provenance, and audit rules as a fresh retrieval.
  A missing, incomplete, or mismatched cache entry MUST make the affected revision unavailable.
- **FR-015**: `read_skill_resource` MUST return one declared textual resource for one exact skill
  revision per request, without returning unrelated resources.
- **FR-016**: A resource MUST be readable only when its normalized relative path and expected
  SHA-256 hash appear in the exact revision's returned resource manifest.
- **FR-017**: Skill documents, manifests, and resources MUST pass schema, text-type, and configured
  size validation before they are returned.
- **FR-018**: Absolute, traversal, encoded traversal, undeclared, cross-revision, binary, and
  oversized resource requests MUST be rejected safely.
- **FR-019**: `load_skill` MUST accept an optional opaque, client-generated repository hash and MUST
  automatically record the exact loaded skill and revision only when that hash is present and valid.
- **FR-020**: Search and loading MUST remain fully functional when no repository hash is
  supplied, and neither operation MUST create persistent repository memory in that case.
- **FR-021**: SkillWire MUST accept a repository hash only when it is exactly 64 lowercase
  hexadecimal characters representing a client-generated SHA-256 digest. SkillWire MUST treat the
  value as opaque and MUST NOT request, derive, retain, or reconstruct source code, local paths,
  file contents, secrets, raw prompts, or raw Git metadata.
- **FR-022**: Repository memory MUST be scoped by both authenticated account and opaque repository
  hash.
- **FR-023**: `list_repo_memory` MUST return the exact skill identities, revisions, and latest
  recorded outcomes previously associated with the caller's account and repository hash.
- **FR-024**: Repository memory MUST survive a normal service restart without losing acknowledged
  load or outcome records.
- **FR-025**: Repeated loads of the same exact revision for the same account and repository hash MUST
  remain represented as one current usage record.
- **FR-026**: `record_skill_outcome` MUST accept only `useful`, `neutral`, or `unsuccessful` for an
  exact revision already loaded under the same account and repository hash.
- **FR-027**: Recording a valid outcome again MUST replace the current outcome for that usage record
  rather than create an unbounded outcome history.
- **FR-028**: `forget_repo_memory` MUST completely erase all load and outcome records for the
  caller's account and supplied repository hash without affecting catalog content, other repository
  hashes, or other accounts.
- **FR-029**: Listing or erasing a repository scope with no memory MUST return an empty or successful
  result without disclosing whether that scope existed previously.
- **FR-030**: Missing or invalid authentication, cross-account access, and attempts to access
  another repository scope MUST be rejected without exposing protected data or resource existence.
- **FR-031**: Requests MUST be schema-validated and subject to documented size and rate limits
  before remote catalog content or persistent memory is accessed.
- **FR-032**: Security-relevant events MUST be auditable without recording raw task descriptions,
  raw repository hashes outside repository memory, source code, local paths, file contents, secrets,
  raw prompts, or raw Git metadata.
- **FR-033**: MCP request and response schemas, ranking, exact-version resolution, provenance,
  resource safety, persistence, repository isolation, account isolation, and the no-local-install
  invariant MUST be verifiable by automated contract and integration acceptance tests.

### MCP Operation Contracts

- **`search_skills`**: Describes a task and optionally supplies an opaque repository hash;
  returns ranked metadata previews only.
- **`load_skill`**: Selects one catalog skill and exact revision and optionally supplies an opaque
  repository hash; returns validated instructions, immutable provenance, and the resource manifest,
  and records the load only when memory is enabled by a repository hash.
- **`read_skill_resource`**: Selects one manifest-declared path from one exact revision; returns that
  resource as validated text.
- **`list_repo_memory`**: Selects the caller's opaque repository hash; returns that
  account-scoped repository's skill usage records and latest outcomes.
- **`record_skill_outcome`**: Selects a previously recorded repository usage and one supported
  outcome; updates the current outcome.
- **`forget_repo_memory`**: Selects the caller's opaque repository hash; erases all usage and
  outcome memory in that account-scoped repository namespace.

### Explicit Exclusions

- Local skill installation or any client-side content materialization.
- Execution of skill scripts, binaries, package managers, hooks, or arbitrary code.
- Automatic crawling of arbitrary repositories or caller-supplied network locations.
- Public skill publishing, a marketplace, billing, teams, or organizations.
- A web dashboard or ForkTTY-specific integration.
- Embeddings, vector databases, or autonomous catalog discovery.

### Key Entities *(include if feature involves data)*

- **Catalog Skill**: A curated skill identity with a name, concise discovery metadata, trust status,
  server-controlled source, and one or more immutable revisions.
- **Skill Revision**: One immutable version of a catalog skill, identified by an exact revision and
  SHA-256 hash covering its validated Markdown instructions, canonical resource manifest, and every
  declared textual resource.
- **Resource Manifest Entry**: A declared safe relative path, SHA-256 resource hash, and
  textual-resource metadata belonging to exactly one skill revision.
- **Search Preview**: A compact ranked representation of a catalog skill that omits full
  instructions and resource bodies while identifying an exact loadable revision.
- **Authenticated Account**: The tenant boundary that owns repository memory and authorizes access
  to all SkillWire operations.
- **Bearer API Key**: An account-wide credential that authenticates exactly one account and
  authorizes all six MVP operations for that account's repository hashes, but no other account.
- **Repository Hash**: An opaque, client-generated SHA-256 repository identity represented as
  exactly 64 lowercase hexadecimal characters and never derived from repository data by SkillWire.
- **Repository Memory**: The namespace formed by an authenticated account and opaque repository
  hash, containing skill usage records but no repository content or identifying metadata.
- **Skill Usage Record**: The association between repository memory and one exact skill revision,
  with an optional current outcome of useful, neutral, or unsuccessful.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a curated evaluation set of task descriptions with catalog matches, at least 90%
  place a relevant skill within the first three previews.
- **SC-002**: In 100% of acceptance tests, search responses contain preview metadata only and no
  complete skill instructions or resource bodies.
- **SC-003**: In 100% of successful load tests, the exact requested revision is returned with source,
  revision, revision-level SHA-256 hash, trust status, and complete resource manifest; the complete
  bundle passes revision integrity verification and every progressively loaded resource passes its
  manifest hash verification.
- **SC-004**: Agents can complete a representative search-to-load journey in no more than three MCP
  operation calls for at least 90% of catalog-covered tasks.
- **SC-005**: In 100% of normal, failure, retry, and cache-path acceptance tests, the monitored
  client filesystem remains unchanged by SkillWire.
- **SC-006**: Repository and account isolation tests show zero cross-hash and cross-account
  memory disclosures across all supported memory operations.
- **SC-007**: Acknowledged repository loads and outcomes remain available after restart in 100% of
  persistence tests, while erased memory remains absent after restart in 100% of erasure tests.
- **SC-008**: All tested invalid resource paths, unknown revisions, oversized content,
  unauthorized requests, cross-account requests, and arbitrary URL inputs are rejected without
  returning protected content, executing skill content, or fetching caller-selected locations.
- **SC-009**: Every launch-catalog entry is text-only, curated, trust-labeled, immutable by revision,
  and within the accepted launch range of eight to twelve skills.

## Assumptions

- Every caller has an authenticated SkillWire account and bearer API key; omitting a repository hash
  disables repository memory but does not make the request anonymous.
- The repository hash is generated by the client outside SkillWire, is exactly 64 lowercase
  hexadecimal characters representing a SHA-256 digest, and is already opaque when supplied;
  SkillWire never receives the source path, remote URL, raw Git metadata, or repository contents
  used to derive it.
- The initial catalog targets ten skills, with eight to twelve accepted at MVP launch to preserve
  the user's "approximately ten" constraint without blocking on an exact count.
- Catalog maintainers provide server-controlled source definitions, immutable revision identifiers,
  trust decisions, validated Markdown documents, and declared textual resources.
- The latest recorded outcome is sufficient for the MVP; outcome history, free-form feedback, and
  inferred usefulness are outside this feature.
- Repository memory records exact revisions rather than floating skill names so prior use remains
  reproducible.
- SkillWire may cache content only inside its own service boundary; cached responses remain subject
  to the same integrity, authorization, validation, provenance, audit, and isolation rules as fresh
  retrieval. Cached fallback is allowed only for the requested exact revision after its complete
  bundle hash is re-verified.
- Content-size and request-rate thresholds are fixed, documented service policies whose exact
  numeric values will be selected during planning and tested at their boundaries.
