# Feature Specification: GitHub Catalog Ingestion

**Feature Branch**: `002-github-catalog-ingestion`

**Created**: 2026-08-11

**Status**: Draft

**Input**: User description: "Discover and safely ingest public GitHub repositories containing
agent skills, then expose verified immutable imports through SkillWire's existing remote delivery
operations."

## Clarifications

### Session 2026-08-11

- Q: When may discovery run and what may it search? → A: It runs asynchronously, never from
  `search_skills`, and searches only public `github.com` repositories under configurable query,
  pagination, and rate budgets.
- Q: What may an administrator register? → A: An administrator may trigger discovery or register
  one owner/repository identity, but may never add individual imported skills.
- Q: How do automatic validation and curation affect classification? → A: Passing validation moves
  discovered candidates to `verified`; failure moves affected candidates to `quarantined` with
  stable reason codes; only an explicit administrator decision can assign `curated`; `verified` is
  structural and operational validation, not semantic endorsement or a safety guarantee.
- Q: How does synchronization preserve revision identity and upstream deletion history? → A: Every
  synchronization uses a complete 40-character commit SHA; changed skill content creates a new
  immutable revision, unchanged content reuses the existing revision, and upstream deletion creates
  an unavailable advisory without deleting the revision; an exact cached revision remains loadable
  unless revoked.
- Q: What licensing evidence is required? → A: A detected SPDX-compatible source license is
  mandatory and is preserved with attribution per revision; missing, conflicting, or unsupported
  licensing quarantines the affected candidate.
- Q: When is an internal skill dependency recorded? → A: Only when conservative evidence names an
  exact skill in the same imported source; the evidence is retained, unresolved edges are never
  invented, and a missing explicitly required internal dependency causes quarantine.
- Q: How does SkillWire determine that a user explicitly requested a user-only skill? → A:
  `search_skills` requires an explicit client-provided user-requested invocation context that
  defaults to automatic when absent; SkillWire never infers user intent from query text.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discover Public Skill Repositories (Priority: P1)

An administrator wants SkillWire to find public `github.com` repositories that appear to contain
agent skills without supplying a list of individual skills. SkillWire performs discovery as a
bounded asynchronous job, searches for recognized manifests and `SKILL.md` layouts, records each
unique repository as a candidate, and keeps newly discovered content unavailable to agents until it
passes verification.

**Why this priority**: Automatic repository discovery is the entry point for growing the catalog
without manual skill-by-skill registration, while the default-deny lifecycle prevents discovery
from becoming implicit trust.

**Independent Test**: Run discovery against controlled search results containing duplicate,
well-formed, malformed, and non-skill repositories. Verify that each canonical repository appears
once as `discovered`, with discovery evidence, and that none of its content appears in default agent
searches.

**Acceptance Scenarios**:

1. **Given** public search results containing a recognized plugin manifest and nested `SKILL.md`
   layouts, **When** discovery completes, **Then** each unique repository is recorded once with the
   evidence that matched it and status `discovered`.
2. **Given** the same repository appears under repeated queries, casing variants, or renamed
   owner/repository coordinates, **When** discovery runs again, **Then** SkillWire updates the same
   candidate rather than creating a duplicate.
3. **Given** a candidate has only been discovered, **When** an agent performs a default skill
   search, **Then** no skill from that candidate is returned.
4. **Given** discovery is queued or running, **When** any agent calls `search_skills`, **Then** the
   search reads only the already published catalog and neither waits for nor triggers GitHub work.

---

### User Story 2 - Register and Import a Repository Once (Priority: P1)

An administrator registers one canonical public `github.com` repository. SkillWire resolves one
exact 40-character upstream commit SHA, discovers all skills covered by the recognized manifest or
layout, verifies the entire pinned snapshot, and publishes every eligible skill without permitting
separate registration for any individual skill.

**Why this priority**: Repository-level registration is the core administrative value and the
boundary that turns an untrusted candidate into immutable, attributable catalog revisions.

**Independent Test**: Register `mattpocock/skills` at acceptance commit
`84fdeffd12f2ee307994d1eb6feb48173b6e0502` and verify one registration imports all 25 skills listed
by `.claude-plugin/plugin.json` version 1.2.3, preserves MIT provenance, and publishes no partial or
mutable revision.

**Acceptance Scenarios**:

1. **Given** an unregistered public repository with a valid `.claude-plugin/plugin.json`, **When**
   an administrator registers its owner/repository identity, **Then** SkillWire pins the resolved
   commit and evaluates every skill path declared by the manifest.
2. **Given** a public repository without a recognized manifest but with multiple nested valid
   `SKILL.md` files, **When** it is registered, **Then** each uniquely rooted skill is evaluated as
   part of the same repository import.
3. **Given** the pinned `mattpocock/skills` acceptance snapshot, **When** import succeeds, **Then**
   all 25 manifest skills are published with Matt Pocock attribution, the repository's MIT license,
   exact source paths, and the exact acceptance commit.
4. **Given** one candidate skill fails required verification, **When** the repository import commits,
   **Then** that candidate is quarantined with stable reason codes, all passing candidates become
   visible together in the atomic snapshot, and no incomplete revision becomes agent-visible.

---

### User Story 3 - Use Imported Skills Remotely (Priority: P1)

An authenticated agent searches for a task-relevant imported skill, loads its exact immutable
instructions and metadata, and reads one declared textual resource progressively through the
existing SkillWire operations. The agent never installs repository content and never chooses a
network location for SkillWire to fetch.

**Why this priority**: Imported content only delivers product value if it preserves SkillWire's
remote-only, progressive, protocol-portable experience and its existing safety boundaries.

**Independent Test**: Complete search, exact load, and one resource read for a verified imported
skill in at most three MCP calls while snapshotting the client tree before and after. Confirm that
search returns previews only, load retains invocation metadata and provenance, the resource read
returns only the requested declared text, and the client tree is unchanged.

**Acceptance Scenarios**:

1. **Given** a verified or curated imported revision relevant to a query, **When** an agent calls
   `search_skills`, **Then** the response contains a ranked preview with immutable source and trust
   metadata but no instruction or resource body.
2. **Given** an exact imported revision returned by search, **When** the agent calls `load_skill`,
   **Then** the response contains the pinned instructions, owner, license, source, invocation
   restrictions, dependency list, complete textual-resource manifest, and immutable hashes.
3. **Given** a declared textual resource from that load response, **When** the agent calls
   `read_skill_resource`, **Then** only that verified resource body is returned and no repository
   content is written into the client environment.
4. **Given** `grill-with-docs` from the pinned acceptance snapshot, **When** it is loaded, **Then**
   `disable-model-invocation: true` is preserved and dependencies on `grilling` and
   `domain-modeling` resolve to skills from the same pinned repository snapshot.
5. **Given** `ask-matt` from the pinned acceptance snapshot, **When** it is loaded and its declared
   `PHASE-BOUNDARIES.md` resource is requested, **Then** that resource is delivered progressively
   from the immutable bundle rather than from the mutable upstream branch.
6. **Given** a verified skill has user-only invocation mode, **When** `search_skills` receives no
   invocation context or an automatic context, **Then** the skill is excluded; **When** the client
   explicitly supplies user-requested context, **Then** the skill may be ranked normally and its
   preview identifies the restriction.

---

### User Story 4 - Synchronize Without Rewriting History (Priority: P2)

An administrator synchronizes a registered repository after its upstream default branch advances.
SkillWire evaluates the new exact 40-character commit SHA, creates a new immutable revision only for
changed skill content, reuses an existing revision for unchanged content, and keeps every older
published revision byte-for-byte and metadata-for-metadata unchanged.

**Why this priority**: Safe synchronization keeps imported skills useful over time without
sacrificing reproducibility, provenance, or rollback to an older known revision.

**Independent Test**: Synchronize a fixture repository across two commits containing changed,
unchanged, and deleted skills, then repeat the second sync. Verify exact commit pinning, a new
revision only for changed content, revision reuse for unchanged content, an unavailable advisory for
deletion, immutable access to older cached revisions, and no duplicate records.

**Acceptance Scenarios**:

1. **Given** a registered repository has a new upstream commit, **When** synchronization succeeds,
   **Then** the repository snapshot identifies the new exact commit, changed skills receive new
   revisions, unchanged skills retain their existing revisions, and older revisions remain
   unchanged.
2. **Given** a synchronization is repeated for an already processed commit, **When** it completes,
   **Then** no duplicate snapshot, skill identity, revision, dependency, resource, or publication is
   created.
3. **Given** a skill's canonical content and immutable metadata are unchanged at a new commit,
   **When** synchronization succeeds, **Then** the new snapshot records equality evidence and reuses
   the existing revision rather than publishing another revision.
4. **Given** GitHub becomes unavailable or rate-limited during synchronization, **When** the attempt
   fails, **Then** the previously published catalog remains available and no partially verified
   snapshot is exposed.
5. **Given** an upstream skill is deleted after publication, **When** synchronization confirms the
   deletion, **Then** SkillWire records an unavailable advisory, removes the skill from default
   discovery, retains the immutable revision, and permits exact verified-cache loads unless the
   revision is revoked.

---

### User Story 5 - Review and Classify Imports (Priority: P3)

An administrator reviews discovered and imported candidates, understands why verification passed or
failed, promotes a verified candidate to curated, or quarantines unsafe content. Agents see only
verified or curated imports in default searches.

**Why this priority**: Structural verification and human curation are different claims. Keeping
their lifecycle states explicit makes trust understandable without claiming automatic semantic
safety.

**Independent Test**: Exercise every allowed status transition with valid and invalid fixtures.
Verify status history, default-search eligibility, exact-load restrictions, immutable publication
metadata, and non-disclosing agent errors.

**Acceptance Scenarios**:

1. **Given** a candidate passes every automatic check, **When** verification completes, **Then** it
   becomes `verified` but is not described as semantically endorsed.
2. **Given** a verified candidate receives explicit administrator review, **When** it is promoted,
   **Then** its current classification becomes `curated` with an attributable decision record.
3. **Given** a candidate fails a safety, provenance, licensing, dependency, or immutability check,
   **When** verification completes, **Then** the affected content is `quarantined` and cannot be
   searched, loaded, or read by agents.
4. **Given** a published revision is later reclassified, **When** its current eligibility changes,
   **Then** the original content, hashes, source commit, and trust-at-publication record do not
   change.

### Edge Cases

- A manifest path is absolute, escapes the repository root after normalization, resolves through a
  symbolic link, points to a submodule, or differs only by a path-casing ambiguity.
- A manifest declares the same skill directory twice, two `SKILL.md` files declare the same name,
  or unrelated repositories use the same skill name.
- A repository contains both a recognized manifest and additional unlisted `SKILL.md` files; the
  manifest remains authoritative and unlisted files are discovery evidence, not implicit imports.
- A repository has no manifest and contains nested valid skills alongside deprecated, fixture,
  vendor, or hidden directories.
- A skill references an absolute path, a path outside the repository, a remote URL, a directory, a
  binary file, a symbolic link, a submodule, an oversized file, invalid text, or an undeclared
  resource.
- A skill references another skill by invocation name but that dependency is absent, duplicated,
  quarantined, or participates in a dependency cycle.
- The manifest license and repository license disagree, attribution is absent, or no license grants
  redistribution rights.
- A branch or tag moves between resolution and content retrieval, a file changes during a read, or
  GitHub returns content from a commit other than the pinned commit.
- A repository or skill is renamed, transferred, archived, deleted, made private, or has its default
  branch changed after a revision was published; upstream removal creates an unavailable advisory
  rather than deleting history.
- GitHub search returns stale results, duplicates, forks, malformed responses, incomplete trees,
  rate-limit responses, or transient failures.
- An upstream commit changes unrelated files while skill content remains identical, or identical
  resource content appears in multiple skills and repositories.
- A synchronization overlaps another synchronization or registration for the same repository.
- A quarantined or discovered revision identifier is guessed and supplied directly to an
  agent-facing operation.
- A caller uses an exact user-only skill name but omits the explicit user-requested invocation
  context; the query text alone must not make that skill discoverable.
- A skill's instructions mention shell commands, package managers, hooks, binaries, or scripts as
  text; SkillWire must retain safe text while never executing the mentioned action.

## Requirements *(mandatory)*

### Functional Requirements

#### Discovery and Administrative Control

- **FR-001**: SkillWire MUST discover candidates only from public repositories hosted on
  `github.com`; GitHub Enterprise and alternate GitHub-compatible hosts are outside the source
  boundary.
- **FR-002**: Discovery MUST use GitHub search for recognized skill evidence, initially including
  `.claude-plugin/plugin.json` manifests and nested `SKILL.md` layouts, under operator-configurable
  query, pagination, result, and GitHub rate budgets.
- **FR-003**: Each discovery result MUST retain the canonical repository identity, current public
  owner/name, matched evidence, discovery time, and discovery status without ingesting it into the
  agent-visible catalog.
- **FR-004**: A newly discovered repository and its skills MUST start as `discovered` and MUST be
  excluded from default agent searches, exact loads, and resource reads.
- **FR-005**: An authenticated administrator MUST be able to trigger a discovery job or register one
  repository by canonical owner/name identity and thereby request evaluation of all skills covered
  by its recognized manifest or layout; no administrative operation may add an individual imported
  skill independently of its repository.
- **FR-006**: Registering an already known repository MUST be idempotent even after casing changes,
  redirects, renames, or ownership transfers that GitHub identifies as the same repository.
- **FR-007**: Registration and synchronization MUST resolve a branch or tag to one complete
  40-character lowercase hexadecimal Git commit SHA before any import is evaluated; mutable or
  abbreviated references MUST never identify a repository snapshot or published revision.
- **FR-008**: Discovery, registration, validation, and synchronization MUST execute asynchronously
  from agent searches. A registered repository MUST support administrator-requested and scheduled
  synchronization for newly observed upstream commits, with at most one active synchronization per
  repository; `search_skills` MUST never trigger, await, or join that work.
- **FR-009**: Agent-facing MCP tools MUST NOT accept repository URLs, GitHub coordinates, commit
  selectors, network locations, or any other field that can initiate discovery, registration, or
  arbitrary retrieval.
- **FR-010**: Private repositories, non-GitHub hosts, and repositories requiring GitHub App
  installation MUST be rejected as unsupported.

#### Immutable, Retrieval-Only Acquisition

- **FR-011**: Every acquisition read MUST be addressed to the exact pinned commit and MUST verify
  that returned repository objects belong to that commit before publication.
- **FR-012**: SkillWire MUST read repository metadata and file content through GitHub's hosted
  interfaces without cloning, checking out, mounting, or executing the repository.
- **FR-013**: All remote requests MUST be derived from a server-controlled GitHub source definition
  and a registered canonical repository identity; redirects or responses that escape those bounds
  MUST be rejected.
- **FR-014**: SkillWire MUST never execute repository scripts, hooks, binaries, workflows, package
  managers, generated commands, or any other repository code during discovery, verification,
  publication, synchronization, search, load, resource read, retry, or cache handling.
- **FR-015**: Repository, manifest, instruction, resource, file-count, dependency-count, and total
  snapshot limits MUST be enforced before publication using bounded operator configuration.
- **FR-016**: Symbolic links, submodules, non-regular repository objects, ambiguous paths, and
  content whose identity changes during acquisition MUST be rejected from imported bundles.

#### Manifest, Skill, and Resource Interpretation

- **FR-017**: SkillWire MUST validate `.claude-plugin/plugin.json` and import every unique skill
  directory listed in its `skills` collection when the manifest is present.
- **FR-018**: A recognized manifest MUST be authoritative for that repository snapshot; additional
  unlisted `SKILL.md` files MAY be recorded as discovery evidence but MUST NOT be implicitly
  published through that manifest.
- **FR-019**: When no recognized manifest is present, SkillWire MUST discover multiple nested
  `SKILL.md` files under allowed repository locations and treat each normalized containing directory
  as a candidate skill root.
- **FR-020**: Each candidate `SKILL.md` MUST yield a valid skill name, description, instruction body,
  source path, and all recognized invocation-restriction metadata.
- **FR-021**: Invocation metadata MUST be preserved, and `disable-model-invocation: true` MUST map to
  SkillWire's user-only invocation mode rather than being discarded or treated as ordinary metadata.
  User-only mode MUST remain bound to the immutable revision.
- **FR-022**: SkillWire MUST identify explicitly referenced relative textual resources from
  recognized manifest metadata and skill-document references without treating ordinary prose as a
  resource declaration.
- **FR-023**: A relative resource path MUST be resolved from the declaring skill directory against
  the pinned repository snapshot, normalized to a safe canonical path inside the repository, and
  published without absolute or traversal segments in the agent-visible resource manifest.
- **FR-024**: Remote links, data URLs, generated paths, directories, undeclared files, and resources
  outside the pinned repository MUST NOT become readable skill resources.
- **FR-025**: A declared resource MUST decode as text, satisfy per-resource and complete-bundle size
  limits, and have an immutable content hash before publication; extension or reported media type
  alone MUST NOT establish that content is text.
- **FR-026**: Search results MUST contain previews only. Instruction bodies, resource bodies, license
  bodies, and unrelated repository content MUST be absent from discovery and search responses.

#### Licensing, Attribution, and Dependencies

- **FR-027**: Every imported revision MUST retain the source repository identity, owner attribution,
  exact originating commit SHA, skill source path, detected SPDX-compatible license identifier,
  license notice, and the evidence used to establish them.
- **FR-028**: A repository-level license MUST apply to imported skills unless a valid, more specific
  skill-level declaration applies; conflicting or ambiguous license evidence MUST fail automatic
  verification.
- **FR-029**: Missing attribution, a missing SPDX-compatible license, unsupported license evidence,
  or conflicting repository, manifest, and skill-level license evidence MUST quarantine the affected
  import rather than silently assigning or guessing a license.
- **FR-030**: Dependency detection MUST use recognized dependency metadata and explicit skill
  invocation references conservatively. A dependency edge may be inferred only when the evidence
  names exactly one skill identity in the same imported source; general prose and fuzzy name matches
  MUST NOT create an edge.
- **FR-031**: Each inferred dependency MUST resolve to a skill in the same repository and pinned
  snapshot, and the immutable revision MUST record the directed edge plus its exact source evidence.
  An unresolved possible reference MUST NOT be invented or substituted from another repository.
- **FR-032**: A recognized required-dependency declaration that is missing, ambiguous, quarantined,
  or cyclic MUST quarantine every affected dependent skill without fetching a substitute from
  another repository. A non-declarative reference with no exact same-source match creates no edge.

#### Verification and Classification

- **FR-033**: Automatic verification MUST produce a deterministic report covering schema validity,
  recognized layout, text-only content, path safety, size limits, exact commit pinning, licensing,
  attribution, provenance completeness, repository/skill/revision/content duplicates, dependency
  integrity, hashes, and create-only immutable publication.
- **FR-034**: Candidates MUST have exactly one current classification from `discovered`, `verified`,
  `quarantined`, or `curated`, with an attributable and timestamped transition history.
- **FR-035**: `verified` MUST mean that all automatic structural, safety, provenance, and publication
  checks passed; it MUST NOT claim semantic correctness, harmlessness, quality, or community
  endorsement.
- **FR-036**: `curated` MUST require an explicit authenticated administrator decision on content
  that has already passed automatic verification; automation MUST NOT assign `curated`.
- **FR-037**: Any required verification failure MUST classify the affected candidate or revision as
  `quarantined` and include one or more stable, documented reason codes plus bounded administrative
  context without exposing unsafe content to agents.
- **FR-038**: Discovered and quarantined content MUST be excluded from default search and MUST be
  rejected by exact agent load and resource operations with the existing non-disclosing error
  posture.
- **FR-039**: Reclassification MUST NOT mutate any published instruction, resource, hash, source
  commit, license, attribution, dependency graph, or immutable trust-at-publication value. Current
  classification and current advisory status MUST remain separate from immutable publication facts.

#### Publication, Synchronization, and Deduplication

- **FR-040**: Each verified or curated import MUST be published as a create-only immutable SkillWire
  revision compatible with the existing exact `load_skill` and `read_skill_resource` guarantees.
- **FR-041**: An imported revision's canonical provenance and complete bundle hash MUST cover the
  exact source commit, skill identity and path, instructions, invocation metadata, license and
  attribution, dependency edges, resource manifest, and every resource hash and body.
- **FR-042**: Publication of one repository snapshot MUST be atomic: all eligible revisions and
  their verification results become visible together, or none of that snapshot's revisions become
  visible.
- **FR-043**: Synchronizing a new commit MUST create a new immutable repository snapshot. Changed
  canonical skill content or immutable metadata MUST create a new revision; unchanged content and
  metadata MUST reuse the existing revision with equality evidence recorded by the new snapshot. A
  synchronization MUST NOT overwrite, repoint, or delete any older published revision.
- **FR-044**: Reprocessing the same canonical repository, commit, skill path, and bundle MUST be
  idempotent and MUST NOT create duplicate repositories, snapshots, skill identities, revisions,
  dependencies, resources, or publication events.
- **FR-045**: Identical instruction, resource, license, or other textual content MUST be
  deduplicated by content hash without collapsing distinct source provenance or exact revision
  identities.
- **FR-046**: Publication collisions, overwrite attempts, hash conflicts, incomplete reads, changed
  upstream objects, or persistence failures MUST roll back the candidate publication and preserve
  the previously visible catalog unchanged.
- **FR-047**: Confirmed upstream deletion MUST create an unavailable advisory and remove the skill
  from default discovery without deleting any SkillWire revision. An exact previously published
  revision MUST remain reproducibly loadable from verified cache when upstream content is renamed,
  removed, changed, or temporarily unavailable, unless its verified advisory status is `revoked`.

#### Existing Agent Operations and Safety Boundaries

- **FR-048**: Default `search_skills` MUST rank eligible verified and curated imports alongside the
  existing catalog using positive textual relevance before repository-memory boosts; discovered,
  quarantined, unavailable, and revoked content MUST not appear. User-only skills MUST also be
  excluded unless the request contains an explicit client-provided user-requested invocation
  context; the context MUST default to automatic when absent and MUST NOT be inferred from query
  text, including an exact skill-name query.
- **FR-049**: Imported search previews MUST retain the existing preview-only contract and identify
  the immutable revision, owner, source repository, source commit, license, trust at publication,
  current classification, invocation mode, and separately derived current advisory status.
- **FR-050**: `load_skill` for an imported exact revision MUST return the complete immutable
  instruction document and metadata, invocation restrictions, dependency graph, license and
  attribution, source provenance, hashes, and declared textual-resource manifest without returning
  resource bodies.
- **FR-051**: `read_skill_resource` MUST return exactly one declared, hash-verified textual resource
  for the exact imported revision and MUST reject traversal, aliases, undeclared paths, changed
  content, binary content, and oversized content.
- **FR-052**: Imported-skill search, load, resource, cache, retry, error, rate-limit, and repository
  memory paths MUST preserve the no-client-install invariant and MUST NOT write catalog content or
  dependencies to client-controlled locations.
- **FR-053**: Existing account isolation, bearer authentication, API-key lifecycle, rate limits,
  request deadlines, cancellation, repository memory, advisory enforcement, and structured-log
  redaction MUST apply unchanged to imported skills.
- **FR-054**: Logs and audit events MUST NOT contain skill instructions, resource or license bodies,
  raw credentials, agent queries, repository-memory hashes, local paths, or unredacted remote
  request data.
- **FR-055**: Timeout, cancellation, validation failure, quarantine, and authorization failure MUST
  prevent late publication, classification, usage-memory, or other persistent side effects.

### Constitutional Boundaries

- Imported instructions and resources remain server-side immutable catalog data delivered only
  through MCP; they are never installed into an agent, repository, home directory, or harness.
- GitHub content is untrusted text. SkillWire validates and hashes it but never executes it and never
  claims that structural verification proves semantic safety or quality.
- Agent callers can select only existing SkillWire identities and exact revisions. Discovery,
  registration, synchronization, and source selection remain authenticated administrative actions.
- Published provenance remains immutable, while current classification and advisory state are
  separately derived controls that can restrict availability without rewriting history.
- Existing repository memory remains account- and repository-scoped and stores no imported content,
  GitHub paths, raw source coordinates, prompts, or client data.

### Out of Scope

- Private GitHub repositories and GitHub App installation.
- Git hosts other than GitHub and agent-supplied arbitrary repository locations.
- A web dashboard or other frontend for discovery, registration, verification, or curation.
- Automatic semantic trust, correctness, quality, or harmlessness guarantees for imported text.
- Community moderation, voting, marketplace features, and billing.
- Execution, checkout, cloning, package installation, or local installation of imported skills or
  repository content.

### Key Entities

- **Repository Candidate**: A canonical public GitHub repository identity, current owner/name,
  discovery evidence, current classification, and classification history.
- **Repository Registration**: The administrator-controlled authorization to evaluate and
  synchronize one canonical repository without accepting agent-provided fetch targets.
- **Repository Snapshot**: One exact 40-character repository commit SHA and its bounded manifest,
  tree, verification result, atomic publication outcome, and mappings to reused or newly created
  skill revisions.
- **Imported Skill Identity**: A stable skill identity scoped by canonical source repository and
  normalized skill root, independent of display-name collisions.
- **Imported Skill Revision**: A create-only immutable bundle for one exact source snapshot,
  containing instructions, invocation metadata, provenance, license, dependency graph, resources,
  hashes, and trust at publication.
- **Snapshot Skill Observation**: Evidence that one skill at a pinned repository snapshot either
  equals an existing immutable revision or differs and therefore requires a new revision; it keeps
  synchronization commit pinning without duplicating unchanged revisions.
- **Textual Resource**: One explicitly declared, safe, bounded, hash-verified text object associated
  with an exact imported revision and available only through progressive resource reading.
- **Skill Dependency**: A directed reference from one imported skill to exactly one other skill in
  the same pinned repository snapshot.
- **Verification Report**: The deterministic result of every required automatic check, including
  stable failure reasons and the exact inputs evaluated.
- **Classification Decision**: An attributable transition among discovered, verified, quarantined,
  and curated that changes eligibility without mutating immutable revision content.
- **Invocation Context**: A per-search client assertion of `automatic` or `user-requested` that
  defaults to `automatic` and controls only the eligibility of user-only skills; SkillWire never
  derives it from query wording.
- **Content Identity**: A content hash used to reuse identical text safely while retaining every
  distinct repository, skill, revision, and provenance identity.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: One registration of `mattpocock/skills` at commit
  `84fdeffd12f2ee307994d1eb6feb48173b6e0502` discovers and successfully publishes 100% of the 25
  skill entries in `.claude-plugin/plugin.json` version 1.2.3, with zero individual skill
  registrations.
- **SC-002**: All 25 acceptance revisions identify Matt Pocock and `mattpocock/skills`, retain the
  MIT license and notice, and reproduce the exact pinned source commit and source path.
- **SC-003**: The acceptance import preserves `disable-model-invocation: true` for every applicable
  skill and records `grill-with-docs` dependencies on exactly `grilling` and `domain-modeling` from
  the same pinned snapshot.
- **SC-004**: An authenticated agent completes an imported skill search, exact load, and declared
  textual resource read in at most three MCP calls, while instruction/resource bodies remain absent
  from search and the client filesystem remains byte-for-byte unchanged.
- **SC-005**: Across fixtures for a new commit, repeated commit, unchanged content, renamed
  repository, duplicate manifest path, and identical cross-skill resource, repeated processing
  creates zero duplicate repository, snapshot, skill, revision, dependency, resource, or publication
  identities.
- **SC-006**: After every successful synchronization, 100% of previously published revisions retain
  identical canonical bytes, hashes, provenance, trust-at-publication metadata, and exact-load
  behavior.
- **SC-007**: 100% of adversarial fixtures covering invalid schemas, unsafe paths, links, submodules,
  binaries, invalid text, size overruns, commit mismatch, licensing gaps, provenance gaps,
  duplicates, missing dependencies, cycles, replacement races, and publication failure are rejected
  or quarantined before agent visibility, with no partial publication.
- **SC-008**: Default agent searches return zero discovered, quarantined, or revoked imports and
  zero unavailable or user-only imports; searches carrying explicit user-requested invocation
  context return eligible user-only skills, and verified or curated acceptance skills satisfy at
  least 90% of a fixed set of relevant imported-skill evaluation queries.
- **SC-009**: Instrumented acceptance tests observe zero repository clone, checkout, script, hook,
  binary, workflow, package-manager, or repository-code executions across success, failure, retry,
  timeout, cancellation, cache, and synchronization paths.
- **SC-010**: Under normal GitHub availability and within configured repository bounds, at least 95%
  of accepted repository registrations and synchronizations reach a deterministic published or
  quarantined outcome within five minutes.
- **SC-011**: Every published imported revision has complete exact-commit provenance, attribution,
  licensing, dependency, resource, and hash fields; releases are blocked when any required field or
  verification result is missing.
- **SC-012**: 100% of agent-facing requests containing repository URLs, GitHub coordinates, mutable
  references, or arbitrary fetch targets are rejected without a network fetch or persistent side
  effect.

## Assumptions

- The initial supported source is public GitHub. Private repositories, GitHub App installation, and
  arbitrary Git hosts require separate future specifications.
- The acceptance baseline is the public `mattpocock/skills` snapshot at commit
  `84fdeffd12f2ee307994d1eb6feb48173b6e0502`; its manifest version 1.2.3 declares 25 skills and its
  repository license is MIT.
- `.claude-plugin/plugin.json` is authoritative when present. In its absence, bounded nested
  `SKILL.md` discovery supplies candidate skill roots.
- Recognized textual resources are explicit relative references in supported manifest metadata or
  skill documents. General prose, remote links, and dynamically constructed paths are not resource
  declarations.
- Automatic verification establishes structural integrity, bounded text retrieval, provenance,
  licensing evidence, dependency resolution, and immutable publication. Only an administrator can
  make the separate qualitative decision to classify verified content as curated.
- Existing SkillWire limits, authentication, rate limiting, deadlines, logging redaction,
  advisory-chain behavior, repository memory, and create-only catalog guarantees remain the
  baseline and are extended rather than replaced.
- GitHub search and content access credentials are operator-controlled service configuration and
  are never accepted from agent requests or published in catalog provenance.
- Discovery queries, pagination, result limits, and rate budgets are bounded operator configuration;
  discovery never extends the latency or side effects of `search_skills`.
- MCP clients are responsible for setting user-requested invocation context only when the user has
  explicitly requested user-only skill discovery; missing context is always treated as automatic.
- A repository may contain text that instructs an agent to execute commands. SkillWire transports
  such instructions as inert data; execution and local installation remain outside the product.
