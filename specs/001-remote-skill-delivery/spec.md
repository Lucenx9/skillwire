# Feature Specification: Remote Skill Delivery MVP

**Feature Branch**: `001-remote-skill-delivery`

**Created**: 2026-08-11

**Status**: Ready for Planning

**Input**: User description: "Build the first MVP of SkillWire as an independent,
MCP-compatible service for just-in-time discovery and retrieval of curated remote skills,
progressive textual resources, immutable provenance, and private repository-scoped usage memory."

## Clarifications

### Session 2026-08-11

- Q: What exact format must clients use for the opaque repository hash? → A: Exactly 64 lowercase
  hexadecimal characters representing a client-generated SHA-256 digest.
- Q: What content must the revision-level SHA-256 hash cover? → A: The skill identifier, revision,
  source reference, source revision, owner, license, `trustAtPublication`, Markdown
  instructions, canonical resource manifest, resource hashes, and every declared resource, with an
  additional SHA-256 hash for each resource.
- Q: How should a recorded outcome affect the limited repository-specific ranking boost? → A:
  Useful gets the larger limited boost, neutral or unrated gets a smaller boost, and unsuccessful
  gets no boost; task relevance remains primary.
- Q: What authorization scope should each bearer API key have? → A: Each key maps to one account and
  may use all six operations for every repository hash in that account.
- Q: When an allowlisted skill source is unavailable, should SkillWire serve an already cached exact
  revision? → A: Yes, but only after verifying the complete cached bundle hash and applying normal
  authentication, validation, provenance, and audit rules.
- Q: How is search quality measured? → A: Against a version-controlled corpus of at least 30 cases,
  with at least three cases for each launch skill and a 90% top-three success threshold.
- Q: How is progressive journey efficiency measured? → A: Against a version-controlled matrix of
  at least 20 catalog-covered tasks, with at least 90% completed using one search call, one load
  call, and at most one resource call.
- Q: What is the repository-memory erasure boundary? → A: Success means synchronous removal from
  the single authoritative live database before returning. Repository memory is always queried
  directly from that database and is never cached. Operator-managed backups, WAL, storage media,
  and restoration are outside the API guarantee and outside this feature.
- Q: Can published provenance change after publication? → A: No. Every published provenance field
  is hash-bound and immutable; later security or availability changes are separate append-only
  advisories.
- Q: How are immutable revisions published and verified? → A: Publication is create-only and
  requires catalog inventory and published provenance to exist before canonical serialization and
  hashing. Verification is a separate read-only operation that recalculates the bundle hash without
  changing files or metadata.
- Q: How is advisory history protected from silent rewriting? → A: The runtime reads a
  version-controlled hash chain whose events carry monotonic sequence numbers, previous-event
  hashes, and their own SHA-256 hashes. Each release records the chain-head hash. After the explicit
  genesis release, release metadata must also record the immutable commit SHA of the previous
  release; CI fails closed if that commit is absent, invalid, or unavailable and rejects changes to
  its published advisory prefix. Merge bases, branch names, and fallback references are not valid
  substitutes.
- Q: Are fixed latency targets part of the MVP contract? → A: No. Performance benchmarks record
  reproducible evidence but impose no fixed threshold and do not block an MVP release.
- Q: Is the first discovery story itself a releasable MVP? → A: No. It is the first vertical slice
  only. A releasable MVP requires all five user stories, all six MCP operations, every security and
  privacy requirement, both evaluation thresholds, and all applicable cross-cutting readiness
  checks.
- Q: How does audit expiration behave during downtime? → A: Logical expiration is unconditional:
  expired events are never returned, read, or used. Physical removal within one hour applies only
  while the service and authoritative database remain continuously operational. Following downtime,
  startup cleanup must complete before readiness; physical deletion cannot be guaranteed while the
  database infrastructure is unavailable.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - First Vertical Slice: Discover Relevant Skills (Priority: P1)

An authenticated AI agent describes a task in natural language and receives a compact, ranked list
of relevant skills from the curated catalog. The agent can decide whether a skill is worth loading
without receiving complete skill instructions or resource content.

**Why this priority**: Discovery is the entry point to SkillWire and delivers immediate value by
making remote skills findable without polluting the client environment.

**Release boundary**: This story is independently demonstrable but is not a releasable MVP by
itself. Release requires User Stories 1 through 5, all six MCP operations, all security and privacy
requirements, both evaluation thresholds, and all applicable cross-cutting readiness checks.

**Independent Test**: Run the version-controlled search evaluation corpus and verify that the
expected skill appears in the first three previews for at least 90% of cases, while every response
contains enough identity and revision information to select a skill but no full instructions or
resources, and exposes both immutable `trustAtPublication` and derived `currentAdvisoryStatus`.

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
6. **Given** the version-controlled search evaluation corpus, **When** every case is evaluated,
   **Then** the expected skill appears within the first three previews for at least 90% of cases and
   every launch skill is represented by at least three cases.
7. **Given** any search preview, **When** the agent inspects its trust information, **Then** it sees
   separate `trustAtPublication` and `currentAdvisoryStatus` fields rather than an ambiguous
   `trustStatus` field.

---

### User Story 2 - Load a Verifiable Skill Revision (Priority: P2)

After choosing a preview, an authenticated agent loads one exact immutable skill revision and
receives its Markdown instructions together with source reference, source revision, owner, license,
immutable `trustAtPublication`, derived `currentAdvisoryStatus`, revision, SHA-256 bundle hash, and
declared resource manifest.

**Why this priority**: Loading turns discovery into usable guidance while preserving reproducibility
and a verifiable chain of provenance.

**Independent Test**: Load a known catalog skill by its exact identity and revision, verify every
provenance field and the content hash, and confirm that repeating the load returns identical content
and metadata.

**Acceptance Scenarios**:

1. **Given** a valid catalog skill and exact revision, **When** the agent calls `load_skill`, **Then**
   it receives the Markdown instructions and complete provenance and resource-manifest metadata.
2. **Given** the same published revision, **When** it is loaded repeatedly, **Then** every published
   provenance field, instruction, manifest entry, resource hash, resource, and bundle hash remains
   identical.
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
8. **Given** a later security revocation or availability change, **When** the affected revision is
   inspected, **Then** the change appears as a separate append-only advisory and the published
   provenance and bundle hash remain unchanged.
9. **Given** complete inventory and published provenance for a new revision, **When** a maintainer
   publishes it, **Then** one new immutable revision is created; attempting to publish the same
   identity and revision again is rejected without overwriting it.
10. **Given** a published revision, **When** a maintainer verifies it, **Then** the complete bundle
    hash is recalculated and checked without modifying any catalog file or metadata.
11. **Given** explicit genesis release metadata and no previous published release or advisory chain,
    **When** advisory history is validated, **Then** genesis is accepted against the defined empty
    chain head.
12. **Given** any later release, **When** advisory history is validated, **Then** its recorded
    previous-release commit SHA is mandatory and must resolve to the exact previous published chain;
    an absent, invalid, or unavailable SHA fails closed, mutation or reordering of that chain is
    rejected, and no merge base, branch, or fallback reference is substituted.

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
5. **Given** the version-controlled journey matrix, **When** every case is attempted, **Then** at
   least 90% select the expected skill and optional resource using no more than one search call, one
   load call, and one resource call.

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

**Independent Test**: Seed one repository load, record each supported outcome in turn, invoke
`forget_repo_memory`, and verify before success is returned that no matching record remains in the
single authoritative live database; restart the service and verify that the erased memory remains
absent.

**Acceptance Scenarios**:

1. **Given** a skill revision previously loaded for a repository, **When** the agent records a
   useful, neutral, or unsuccessful outcome, **Then** that outcome is visible in the repository's
   inspectable memory.
2. **Given** an unsupported outcome or a skill revision not previously loaded for that repository,
   **When** the agent records an outcome, **Then** the request is rejected without changing memory.
3. **Given** repository memory containing loads and outcomes, **When** the account invokes
   `forget_repo_memory`, **Then** success is returned only after all memory for that account and
   repository hash is removed transactionally from the authoritative live database.
4. **Given** a successful erasure, **When** subsequent memory calls are made or the service restarts,
   **Then** the deleted loads and outcomes remain absent unless a later agent action creates new
   usage memory.
5. **Given** an unauthenticated caller or a different account, **When** it attempts to inspect,
   update, or erase the repository memory, **Then** access is rejected without revealing whether
   the target memory exists.
6. **Given** a successful erasure, **When** its audit record is retained, **Then** it contains only
   account identifier, request identifier, creation timestamp, `expiresAt`, operation result, and
   removed-record count; it is ignored immediately at expiration and, while the service and
   authoritative database remain continuously operational, is physically removed no later than one
   hour afterward.

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
- A malformed evaluation case, unknown expected skill, missing required launch-skill coverage, or
  duplicate case identifier makes the affected evaluation corpus invalid rather than silently
  reducing its denominator.
- A journey case without an optional resource completes after search and load; a case with a
  resource permits exactly one additional resource read.
- A change to any published provenance field or content under an existing revision produces an
  integrity failure and never replaces the published revision.
- Publication attempted before inventory and complete provenance exist is rejected without creating
  a partial revision; publication attempted for an existing exact revision is rejected without
  changing the existing revision.
- Verification detects drift and fails without modifying catalog files or metadata.
- A security or availability advisory never changes `trustAtPublication` or the published bundle
  hash. A broken advisory hash link, duplicate or skipped sequence, or release-head mismatch makes
  the advisory state invalid rather than silently deriving a status.
- Genesis release metadata is invalid if a previous published catalog release or advisory chain
  exists. After genesis, a missing, invalid, or unavailable previous-release commit SHA fails closed;
  validation never discovers a substitute through a merge base, branch name, or fallback reference.
- If repository memory cannot be removed from the authoritative live database, erasure does not
  report success.
- An audit record whose `expiresAt` has passed is never returned or used even if physical cleanup
  has not yet run. While the service and authoritative database are continuously operational,
  hourly cleanup removes it within the permitted one-hour grace period. After either has been
  unavailable, startup cleanup must finish before readiness is reported; physical removal is not
  guaranteed while the database infrastructure remains unavailable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The MVP MUST expose `search_skills`, `load_skill`, `read_skill_resource`,
  `list_repo_memory`, `record_skill_outcome`, and `forget_repo_memory` as its agent-facing MCP
  operations.
- **FR-002**: Every operation MUST require a bearer API key that authenticates exactly one account
  before processing the request or accessing account-scoped data. Each valid key MUST authorize all
  six MVP operations across every repository hash in that account and MUST NOT authorize access to
  any other account.
- **FR-003**: The launch catalog MUST contain exactly these ten first-party text-only skills:
  `typescript-code-review`, `react-accessibility`, `node-api-design`, `postgres-schema-review`,
  `vitest-test-design`, `threat-modeling`, `github-actions-ci`, `dockerfile-hardening`,
  `technical-documentation`, and `dependency-upgrade-planning`. Each skill MUST have one
  version-controlled `SKILL.md` and exactly one declared textual resource under `references/`.
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
  name, concise description, matching capability summary, immutable `trustAtPublication`, derived
  `currentAdvisoryStatus`, and an exact immutable revision identifier suitable for `load_skill`.
  `currentAdvisoryStatus` MUST be one of `available`, `unavailable`, or `revoked`, as derived from the
  verified advisory chain; an empty chain yields `available`, and security revocation is terminal.
  Neither trust field MUST be represented only by an ambiguous `trustStatus` field.
- **FR-010**: Search previews MUST NOT contain complete skill instructions or resource bodies.
- **FR-011**: `load_skill` MUST require a stable skill identifier and exact immutable revision; it
  MUST NOT silently select a different or floating revision.
- **FR-012**: A successful load MUST return the complete validated Markdown instructions, skill
  identifier, exact revision, source reference, source revision, owner, license,
  `trustAtPublication`, `currentAdvisoryStatus`, revision-level SHA-256 hash, and complete declared
  resource manifest. The canonical revision bundle and its SHA-256 MUST cover every published
  provenance field, including `trustAtPublication`, plus the instructions, canonical manifest,
  every resource hash, and every declared resource. `currentAdvisoryStatus` MUST be derived from the
  separately verified advisory chain and MUST NOT be included in or mutate the published revision
  bundle. Each manifest entry MUST include that resource's SHA-256 hash. Neither trust field MUST be
  represented only by an ambiguous `trustStatus` field.
- **FR-013**: A revision MUST be created only through a create-only catalog publication operation.
  Catalog inventory and complete published provenance MUST exist before final canonical
  serialization, hashing, and publication. Publication MUST reject an existing exact revision and
  MUST NOT overwrite or partially replace it. A published revision MUST always resolve to identical
  published provenance and content, including source reference, source revision, owner, license,
  `trustAtPublication`, instructions, canonical resource manifest, resource hashes, and resources.
  Any change to one of these values MUST be published as a new revision with a new bundle hash.
  Catalog verification MUST be a separate read-only operation that recalculates and checks the
  complete bundle hash without modifying files, content, inventory, provenance, or revision
  metadata.
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
- **FR-028**: `forget_repo_memory` MUST return success only after synchronously removing all load and
  outcome records for the caller's account and supplied repository hash transactionally from the
  authoritative live database. It MUST NOT affect catalog content, other repository hashes, or
  other accounts.
- **FR-029**: Listing or erasing a repository scope with no memory MUST return an empty or successful
  result without disclosing whether that scope existed previously.
- **FR-030**: Missing or invalid authentication, cross-account access, and attempts to access
  another repository scope MUST be rejected without exposing protected data or resource existence.
- **FR-031**: Requests MUST be schema-validated and subject to documented size and rate limits
  before remote catalog content or persistent memory is accessed.
- **FR-032**: Security-relevant events MUST be auditable without recording raw task descriptions,
  raw repository hashes outside repository memory, source code, local paths, file contents, secrets,
  raw prompts, or raw Git metadata. A repository-memory deletion audit record MAY contain only the
  account identifier, request identifier, creation timestamp, `expiresAt`, operation result, and
  number of removed records; it MUST NOT contain a repository hash, skill identifier, outcome,
  query, or usage detail. `expiresAt` MUST equal the creation timestamp plus exactly 30 days.
  Expired records MUST never be returned, read, or used by the application and MUST never influence
  application behavior. While the service and authoritative database remain continuously
  operational, cleanup MUST run at least hourly and physically remove each record no later than one
  hour after expiration. After service or database downtime, startup cleanup MUST complete before
  the service reports readiness. SkillWire MUST document that it cannot guarantee physical deletion
  while its database infrastructure is unavailable.
- **FR-033**: MCP request and response schemas, ranking, exact-version resolution, provenance,
  create-only publication, read-only verification, advisory-chain integrity, resource safety,
  persistence, repository-memory erasure and audit expiry, repository isolation, account isolation,
  and the no-local-install invariant MUST be verifiable by automated contract and integration
  acceptance tests.
- **FR-034**: The project MUST maintain a version-controlled search evaluation corpus containing at
  least 30 representative cases and at least three cases for every launch skill. Every case MUST
  have a stable case identifier, task query, expected skill identifier, and rationale. Missing
  launch-skill coverage, an unknown expected skill, or a malformed case MUST invalidate the corpus.
- **FR-035**: The project MUST maintain a version-controlled progressive-journey matrix containing
  at least 20 representative catalog-covered tasks. Every case MUST have a stable case identifier,
  task description, expected skill identifier, and optional expected resource path. The recorded
  result MUST include the selected skill and counts for each operation used.
- **FR-036**: The launch catalog inventory MUST record each skill's identifier, purpose, expected
  resource path, owner, license, repository source reference, immutable source revision, and
  first-party reviewed `trustAtPublication` rationale. The inventory and all published provenance
  MUST exist before the corresponding `SKILL.md`, manifest, and resource are canonically serialized,
  hashed, and published as one immutable revision.
- **FR-037**: A security revocation or availability change after publication MUST create a separate
  advisory associated with the immutable revision and MUST NOT rewrite published provenance,
  `trustAtPublication`, content, or bundle hash. The advisory log MUST be version-controlled,
  read-only at runtime, and append-only. Every event MUST contain a monotonic sequence number, the
  previous event's SHA-256 hash, and its own SHA-256 event hash calculated from the canonical event
  fields other than that event-hash field. The first event MUST use 64 lowercase zeroes as its
  previous-event hash. Every catalog release MUST record the verified advisory-chain head hash; an
  empty chain MUST use 64 lowercase zeroes as its head. The genesis release MUST be explicitly
  identified and is valid only when no previous published advisory chain or catalog release exists.
  Every later release MUST record the explicit immutable commit SHA of the previous published
  release. CI MUST fail closed when that SHA is absent, invalid, or unavailable and MUST compare the
  proposed advisory chain to the chain stored at that exact commit. Merge-base discovery, branch
  names, and optional fallback references MUST NOT substitute for the recorded commit SHA. CI MUST
  reject mutation, deletion, insertion within the previously published prefix, reordering, sequence
  gaps or duplicates, broken hash links, and a release-head mismatch; only a valid tail append may
  extend the chain. SkillWire MUST expose no runtime operation for creating, editing, deleting, or
  reordering advisories. Security-revoked revisions MUST not be returned by search or load.
  Availability advisories MUST preserve the verified-cache rules in FR-014.
- **FR-038**: The MVP MUST use one authoritative live PostgreSQL database for repository memory and
  MUST query repository memory directly from that database. In-memory, distributed, and
  application-local repository-memory caches MUST NOT be introduced. `forget_repo_memory` MUST
  delete matching load and outcome rows transactionally from the authoritative database before
  returning success. Deleted memory MUST remain absent from subsequent calls and after normal
  server restarts, unless a later agent action creates new usage memory. The operation MUST remain
  idempotent and MUST NOT reveal whether matching memory existed. SkillWire MUST NOT manage database
  replicas, WAL archives, backup systems, restore workflows, or backup credentials in this feature.
- **FR-039**: User-facing privacy and operator documentation MUST distinguish the API guarantee from
  operator responsibilities: successful erasure synchronously removes repository memory from the
  authoritative live database, while physical deletion from operator-managed backups, WAL,
  snapshots, or storage media is outside the API guarantee and is the deployment operator's
  responsibility. The documentation MUST distinguish unconditional logical audit expiration from
  availability-qualified physical cleanup and MUST state that physical deletion cannot be
  guaranteed while the authoritative database infrastructure is unavailable.
- **FR-040**: MVP performance benchmarks MUST be informative engineering measurements and MUST NOT
  impose a fixed latency threshold or block release based on timing. Each benchmark report MUST
  record the execution environment, catalog dataset and revision, concurrency, cache state, sample
  count, and measured results so later releases can establish evidence-based targets.
- **FR-041**: User Story 1 MUST be treated only as the first independently demonstrable vertical
  slice. A releasable MVP MUST include User Stories 1 through 5, all six MCP operations, every
  security and privacy requirement, both evaluation thresholds, and all applicable cross-cutting
  readiness checks. Completion of User Story 1 alone MUST NOT be represented as MVP completion or
  release readiness.

### Launch Catalog Inventory

All source references below are repository-controlled logical references. Source revision `1.0.0`
is immutable once published. Every entry is owned by **SkillWire maintainers**, licensed under
**Apache-2.0**, and contains its instructions in `SKILL.md` plus the single declared resource shown.

| Skill identifier | Purpose | Expected resource path | Owner | License | Repository source reference | Source revision | Trust rationale |
|------------------|---------|------------------------|-------|---------|-----------------------------|-----------------|-----------------|
| `typescript-code-review` | Review TypeScript changes for correctness, type safety, maintainability, and regressions. | `references/review-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/typescript-code-review` | `1.0.0` | First-party authored and reviewed for strict TypeScript review; source and license verified at publication. |
| `react-accessibility` | Review React interfaces for accessible structure, semantics, input, focus, and feedback. | `references/accessibility-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/react-accessibility` | `1.0.0` | First-party authored and reviewed for accessibility analysis; source and license verified at publication. |
| `node-api-design` | Design and review clear, compatible, secure Node.js service interfaces. | `references/api-review-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/node-api-design` | `1.0.0` | First-party authored and reviewed for service-interface design; source and license verified at publication. |
| `postgres-schema-review` | Review PostgreSQL schemas, constraints, indexes, migrations, and data integrity. | `references/schema-review-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/postgres-schema-review` | `1.0.0` | First-party authored and reviewed for relational data design; source and license verified at publication. |
| `vitest-test-design` | Design focused Vitest unit, contract, integration, and failure-path coverage. | `references/test-design-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/vitest-test-design` | `1.0.0` | First-party authored and reviewed for test-design guidance; source and license verified at publication. |
| `threat-modeling` | Identify assets, trust boundaries, attacker goals, abuse cases, and mitigations. | `references/threat-model-template.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/threat-modeling` | `1.0.0` | First-party authored and security-reviewed for defensive threat modeling; source and license verified at publication. |
| `github-actions-ci` | Design maintainable GitHub Actions validation and delivery workflows. | `references/ci-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/github-actions-ci` | `1.0.0` | First-party authored and reviewed for CI workflow design; source and license verified at publication. |
| `dockerfile-hardening` | Review container builds for minimal images, least privilege, reproducibility, and secret safety. | `references/hardening-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/dockerfile-hardening` | `1.0.0` | First-party authored and security-reviewed for container hardening; source and license verified at publication. |
| `technical-documentation` | Produce accurate, audience-appropriate technical documentation and validation guides. | `references/documentation-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/technical-documentation` | `1.0.0` | First-party authored and reviewed for technical communication; source and license verified at publication. |
| `dependency-upgrade-planning` | Plan dependency upgrades with compatibility research, migration steps, tests, and rollback. | `references/upgrade-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/dependency-upgrade-planning` | `1.0.0` | First-party authored and reviewed for safe dependency evolution; source and license verified at publication. |

### MCP Operation Contracts

- **`search_skills`**: Describes a task and optionally supplies an opaque repository hash;
  returns ranked metadata previews containing separate `trustAtPublication` and
  `currentAdvisoryStatus` fields only.
- **`load_skill`**: Selects one catalog skill and exact revision and optionally supplies an opaque
  repository hash; returns validated instructions, hash-bound immutable published provenance, the
  resource manifest, separate `trustAtPublication` and `currentAdvisoryStatus` fields, and records
  the load only when memory is enabled by a repository hash.
- **`read_skill_resource`**: Selects one manifest-declared path from one exact revision; returns that
  resource as validated text.
- **`list_repo_memory`**: Selects the caller's opaque repository hash; returns that
  account-scoped repository's skill usage records and latest outcomes.
- **`record_skill_outcome`**: Selects a previously recorded repository usage and one supported
  outcome; updates the current outcome.
- **`forget_repo_memory`**: Selects the caller's opaque repository hash; erases all usage and
  outcome memory in that account-scoped repository namespace and reports success only after the
  authoritative live database reflects the erasure.

### Explicit Exclusions

- Local skill installation or any client-side content materialization.
- Execution of skill scripts, binaries, package managers, hooks, or arbitrary code.
- Automatic crawling of arbitrary repositories or caller-supplied network locations.
- Public skill publishing, a marketplace, billing, teams, or organizations.
- A web dashboard or ForkTTY-specific integration.
- Embeddings, vector databases, or autonomous catalog discovery.
- In-memory, distributed, or application-local caching of repository memory. Verified immutable
  catalog caching remains allowed within the SkillWire service boundary.
- Management of database replicas, WAL archives, backup systems, restore workflows, backup
  credentials, or physical deletion from operator-managed storage media.
- Fixed latency requirements or release-blocking performance thresholds for the MVP.

### Repository-Memory Erasure and Audit-Retention Boundary

The live-data erasure guarantee is synchronous: a successful `forget_repo_memory` response means
the account/repository scope was deleted transactionally from the single authoritative live
PostgreSQL database. Repository memory is queried directly from that database and is never cached
in memory, in a distributed cache, or in an application-local cache. Subsequent calls and normal
server restarts cannot recover the deleted memory; a later skill load may create new usage memory.
Failure to complete the database deletion prevents a success response. Repeating the operation
remains successful and does not reveal whether memory previously existed.

Repository-memory deletion audit events contain only account identifier, request identifier,
creation timestamp, `expiresAt`, operation result, and removed-record count. They contain no
repository hash, skill identifier, outcome, query, or usage detail. `expiresAt` is exactly 30 days
after creation. Once expired, an event is unconditionally excluded from every application query,
read, and decision and can never influence application behavior, even if physical cleanup is
pending. While the service and authoritative database remain continuously operational, hourly
cleanup physically removes an expired event no later than one hour after expiration. After service
or database downtime, startup cleanup must complete before the service reports readiness. SkillWire
cannot guarantee physical deletion while its authoritative database infrastructure is unavailable.

Physical deletion from operator-managed backups, WAL archives, snapshots, or storage media is
outside the `forget_repo_memory` API guarantee and is the deployment operator's responsibility.
SkillWire does not manage or receive backup credentials and does not implement backup restoration
or replica propagation in this feature.

### Key Entities *(include if feature involves data)*

- **Catalog Skill**: A curated first-party skill identity with a name, concise discovery metadata,
  owner, license, `trustAtPublication` rationale, server-controlled source reference, immutable
  source revision, and one or more immutable revisions.
- **Skill Revision**: One immutable version of a catalog skill, identified by an exact revision and
  SHA-256 hash covering its identity, published provenance, validated Markdown instructions,
  canonical resource manifest, resource hashes, and every declared textual resource.
- **Published Provenance**: The immutable source reference, source revision, owner, license, and
  `trustAtPublication` status bound into one skill revision's canonical bundle.
- **Revision Advisory**: A version-controlled, runtime-read-only security-revocation or availability
  event containing a monotonic sequence number, previous-event hash, and its own SHA-256 event hash.
  It contributes to `currentAdvisoryStatus` without changing the revision, published provenance,
  content, or bundle hash.
- **Advisory Chain Head**: The SHA-256 event hash of the final advisory event acknowledged by a
  catalog release, or the defined empty-chain value when no advisory exists.
- **Catalog Release Metadata**: The immutable record of one published catalog release and its
  verified advisory-chain head. It explicitly identifies the genesis release or, for every later
  release, records the immutable commit SHA of the previous published release.
- **Resource Manifest Entry**: A declared safe relative path, SHA-256 resource hash, and
  textual-resource metadata belonging to exactly one skill revision.
- **Search Preview**: A compact ranked representation of a catalog skill that omits full
  instructions and resource bodies while identifying an exact loadable revision and exposing
  separate `trustAtPublication` and `currentAdvisoryStatus` fields.
- **Search Evaluation Case**: A version-controlled case containing a stable identifier, task query,
  expected launch-skill identifier, and rationale.
- **Journey Evaluation Case**: A version-controlled case containing a stable identifier, task
  description, expected skill identifier, optional expected resource path, selected result, and
  operation counts.
- **Authenticated Account**: The tenant boundary that owns repository memory and authorizes access
  to all SkillWire operations.
- **Bearer API Key**: An account-wide credential that authenticates exactly one account and
  authorizes all six MVP operations for that account's repository hashes, but no other account.
- **Repository Hash**: An opaque, client-generated SHA-256 repository identity represented as
  exactly 64 lowercase hexadecimal characters and never derived from repository data by SkillWire.
- **Repository Memory**: The namespace formed by an authenticated account and opaque repository
  hash, containing skill usage records but no repository content or identifying metadata. It is
  queried directly from the authoritative database and is never cached.
- **Skill Usage Record**: The association between repository memory and one exact skill revision,
  with an optional current outcome of useful, neutral, or unsuccessful.
- **Erasure Audit Record**: A privacy-safe deletion event containing only account identifier,
  request identifier, creation timestamp, `expiresAt`, operation result, and removed-record count;
  it expires logically exactly 30 days after creation. While the service and authoritative database
  remain continuously operational, it is physically removed within the next hour; after downtime,
  cleanup completes before readiness.
- **Performance Benchmark Report**: Informative evidence recording environment, catalog dataset and
  revision, concurrency, cache state, sample count, and measured results without imposing a release
  threshold.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The version-controlled search corpus contains at least 30 valid cases and at least
  three cases for each of the ten launch skills; in at least 90% of all cases, the case's expected
  skill appears within the first three previews.
- **SC-002**: In 100% of acceptance tests, search responses contain preview metadata only and no
  complete skill instructions or resource bodies.
- **SC-003**: In 100% of successful load tests, the exact requested revision is returned with
  identical skill identity, source reference, source revision, owner, license,
  `trustAtPublication`, separately derived `currentAdvisoryStatus`, revision-level SHA-256 hash,
  instructions, and complete resource manifest; the complete published bundle passes integrity
  verification and every progressively loaded resource passes its manifest hash verification.
- **SC-004**: The version-controlled journey matrix contains at least 20 valid catalog-covered
  cases; at least 90% select the expected skill and optional resource using no more than one
  `search_skills` call, one `load_skill` call, and at most one `read_skill_resource` call.
- **SC-005**: In 100% of normal, failure, retry, and cache-path acceptance tests, the monitored
  client filesystem remains unchanged by SkillWire.
- **SC-006**: Repository and account isolation tests show zero cross-hash and cross-account
  memory disclosures across all supported memory operations.
- **SC-007**: Acknowledged repository loads and outcomes remain available after restart in 100% of
  persistence tests. In 100% of successful erasure tests, memory is absent from the primary
  authoritative live database before success and remains absent after subsequent calls and a normal
  server restart. In 100% of repository-memory access tests, reads go directly to the authoritative
  database and no repository-memory cache exists. Repeated erasure succeeds without revealing
  whether memory existed.
- **SC-008**: All tested invalid resource paths, unknown revisions, oversized content,
  unauthorized requests, cross-account requests, and arbitrary URL inputs are rejected without
  returning protected content, executing skill content, or fetching caller-selected locations.
- **SC-009**: All ten named launch-catalog entries have a version-controlled `SKILL.md`, exactly one
  declared textual resource under `references/`, and an inventory record matching the required
  identifier, purpose, resource path, owner, Apache-2.0 license, repository source reference,
  immutable source revision, and first-party reviewed trust rationale.
- **SC-010**: In 100% of repeated-load integrity tests, every published provenance and content field
  remains byte-for-byte identical for the same revision; create-only publication rejects overwrite,
  and read-only verification detects drift without changing catalog files or metadata. In 100% of
  advisory-chain tests, the explicit genesis release succeeds only when no previous release or chain
  exists; every later release is compared with the chain at its recorded previous-release commit
  SHA; an absent, invalid, or unavailable SHA fails closed; changes to a previously published event
  or its ordering are rejected; valid tail appends advance the recorded chain head; and advisories
  never change the published bundle hash or `trustAtPublication`.
- **SC-011**: In 100% of erasure-retention tests, deletion audit records contain only the six
  permitted fields, receive `expiresAt` exactly 30 days after creation, are never returned or used
  at or after expiration, and never influence application behavior. While the service and
  authoritative database are continuously operational, hourly cleanup physically removes every
  expired event no later than one hour after expiration. Following simulated service or database
  downtime, startup cleanup completes before readiness is reported.
- **SC-012**: Every performance benchmark report records environment, catalog dataset and revision,
  concurrency, cache state, sample count, and measured results. No MVP acceptance or release result
  depends on meeting a fixed latency threshold.
- **SC-013**: In 100% of release-readiness checks, an MVP release is rejected unless User Stories 1
  through 5, all six MCP operations, every security and privacy requirement, both evaluation
  thresholds, and every applicable cross-cutting readiness check are complete. Completion of User
  Story 1 alone is reported only as completion of the first vertical slice.

## Assumptions

- Every caller has an authenticated SkillWire account and bearer API key; omitting a repository hash
  disables repository memory but does not make the request anonymous.
- The repository hash is generated by the client outside SkillWire, is exactly 64 lowercase
  hexadecimal characters representing a SHA-256 digest, and is already opaque when supplied;
  SkillWire never receives the source path, remote URL, raw Git metadata, or repository contents
  used to derive it.
- The launch catalog contains exactly the ten first-party skills in the Launch Catalog Inventory;
  changing that set requires a specification update rather than autonomous discovery or publishing.
- SkillWire maintainers own and review every launch entry, its Apache-2.0 licensing, immutable
  repository source revision, `trustAtPublication` rationale, validated `SKILL.md`, and single
  declared textual resource.
- Search and journey evaluation artifacts are reviewed version-controlled product data. Invalid or
  missing cases fail evaluation rather than being removed from the denominator silently.
- The latest recorded outcome is sufficient for the MVP; outcome history, free-form feedback, and
  inferred usefulness are outside this feature.
- Repository memory records exact revisions rather than floating skill names so prior use remains
  reproducible.
- SkillWire may cache verified immutable catalog content only inside its own service boundary;
  cached catalog responses remain subject to the same integrity, authorization, validation,
  provenance, audit, and isolation rules as fresh retrieval. Cached fallback is allowed only for the
  requested exact revision after its complete bundle hash is re-verified.
- Repository memory has one authoritative live PostgreSQL database and is always queried directly
  from it. In-memory, distributed, and application-local repository-memory caches are outside this
  feature. Database replicas, WAL archives, backup systems, restore workflows, backup credentials,
  and physical-media deletion remain outside this feature and under deployment-operator control.
- Catalog publication is an offline create-only maintenance action. Runtime operations cannot
  publish or overwrite revisions or edit advisories. Verification is read-only.
- An append-only advisory changes `currentAdvisoryStatus` and may change whether an immutable
  revision can currently be discovered or served; it never changes the revision's published
  provenance, content, or `trustAtPublication` record.
- Catalog release metadata explicitly marks the genesis release. Every later release records the
  immutable commit SHA of the previous published release; CI has access to that exact commit and
  fails closed rather than substituting a merge base, branch, or fallback reference.
- Logical audit expiration remains enforceable regardless of cleanup state. The one-hour physical
  cleanup bound assumes continuous service and authoritative-database availability; after downtime,
  the service remains unready until startup cleanup succeeds, and no physical-deletion guarantee is
  made while the database infrastructure is unavailable.
- User Story 1 is only the first vertical slice. The releasable MVP includes all five stories, all
  six MCP operations, all required security and privacy behavior, both evaluation thresholds, and
  applicable cross-cutting readiness checks.
- Performance measurements are retained as reproducible engineering evidence; fixed latency targets
  may be proposed only after evidence is collected and require a future specification update before
  becoming contractual or release-blocking.
- Content-size and request-rate thresholds are fixed, documented service policies whose exact
  numeric values will be selected during planning and tested at their boundaries.
