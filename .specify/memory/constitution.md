<!--
Sync Impact Report
- Version change: unratified template → 1.0.0
- Modified principles:
  - Principle 1 placeholder → I. Remote Delivery, Never Client Installation
  - Principle 2 placeholder → II. Retrieval, Not Arbitrary Execution
  - Principle 3 placeholder → III. Protocol Portability
  - Principle 4 placeholder → IV. Immutable Provenance
  - Principle 5 placeholder → V. Private Repository Memory
- Added principles:
  - VI. Untrusted-Content Security
  - VII. Test-Backed Contracts
  - VIII. Maintainable MVP
- Added sections:
  - Architectural and Scope Constraints
  - Development and Quality Gates
- Removed sections: None; all template sections were resolved.
- Follow-up TODOs: None.
-->
# SkillWire Constitution

## Core Principles

### I. Remote Delivery, Never Client Installation (NON-NEGOTIABLE)

Catalog skills and their resources MUST be delivered through MCP and consumed transiently.
SkillWire MUST NOT copy or install them into a client repository, user home directory, agent skill
directory, package directory, agent harness, or any other client-side location. Server-side caching
is permitted within SkillWire's service boundary, provided it never materializes catalog content on
the client. Any workflow that requires client installation is non-compliant.

This boundary keeps remote discovery independent of local state and prevents SkillWire from
polluting or mutating user environments.

### II. Retrieval, Not Arbitrary Execution (NON-NEGOTIABLE)

The MVP MUST retrieve only schema-validated Markdown skill instructions and explicitly declared
textual resources. SkillWire MUST NOT execute downloaded scripts, binaries, package managers,
hooks, or arbitrary code. Retrieved resources MUST be returned as data and MUST NOT be interpreted
as server-side commands or executable extensions.

This limitation makes retrieval behavior auditable and prevents a content service from becoming a
remote code-execution system.

### III. Protocol Portability

SkillWire MUST expose its core capabilities through the MCP protocol and MUST NOT depend on
ForkTTY or any specific agent harness for discovery, loading, provenance, ranking, or memory.
Agent-specific adapters MAY exist only as optional, separate integrations. The core service MUST
remain usable by any conforming MCP client without an adapter.

Protocol portability preserves interoperability and prevents one client implementation from
defining the service architecture.

### IV. Immutable Provenance

Every loaded skill response MUST identify the skill's source, immutable revision, SHA-256 content
hash, trust status, and complete declared resource manifest. Once published, a revision MUST NOT
resolve to different content or metadata. Any content or manifest change MUST produce a new
revision and corresponding hash; silent mutation is forbidden.

Immutable provenance makes a load reproducible, reviewable, and attributable even when upstream
content later changes.

### V. Private Repository Memory

Skill usage MAY be remembered per repository only through an opaque repository fingerprint scoped
to the authenticated account. SkillWire MUST NOT store source code, local paths, file contents,
secrets, raw prompts, or raw Git metadata. Repository memory MUST be tenant-isolated, inspectable
by the authenticated account, and erasable on request.

These limits allow useful repository-specific ranking without turning usage memory into a copy of
private development data.

### VI. Untrusted-Content Security

Every skill document and resource MUST be treated as untrusted input. Retrieval MUST enforce
operator-curated source allowlists, bounded document and resource sizes, safe relative resource
paths, schema validation, authentication, rate limits, tenant isolation, and auditable security
events. MCP callers MUST NOT provide arbitrary URLs for SkillWire to fetch; remote content MUST be
resolved only from catalog entries and server-controlled source definitions.

These controls constrain both malicious catalog content and attempts to use SkillWire as an
open-ended network fetcher.

### VII. Test-Backed Contracts

Automated contract and integration tests MUST cover MCP request and response schemas, ranking,
version resolution, repository and tenant isolation, persistence, resource path safety, immutable
provenance, and the no-local-install invariant. A behavior change in any of these areas MUST include
updated tests, and failing required tests MUST block release.

The service's safety and portability claims are enforceable only when their observable contracts
are continuously verified.

### VIII. Maintainable MVP

The MVP MUST begin as one modular TypeScript service backed by a small, curated catalog. A web UI,
marketplace, billing system, microservice decomposition, vector database, autonomous catalog
crawler, or ForkTTY integration MUST NOT be added without a separate specification that explains
the need, boundaries, risks, migrations, and tests. New scope MUST still comply with every other
principle in this constitution.

This constraint keeps the initial system understandable and makes expansion an explicit product
and architectural decision.

## Architectural and Scope Constraints

- The service boundary MUST contain catalog discovery, validated textual retrieval, provenance,
  ranking, repository-scoped memory, and audit behavior behind MCP contracts.
- Modules MUST preserve explicit boundaries between catalog metadata, remote retrieval, content
  validation, persistence, and protocol transport, even while deployed as one service.
- Catalog entries MUST refer only to curated, server-configured sources and immutable revisions.
- Declared resources MUST be textual, included in the provenance manifest, size-bounded, and
  addressable only by normalized safe relative paths. Absolute paths, traversal segments, and
  undeclared resources MUST be rejected.
- Server-side caches MUST be keyed by immutable identity or verified content hash. A cache hit MUST
  preserve the same validation, provenance, authorization, and tenant-isolation guarantees as a
  fresh retrieval.
- Optional harness adapters MUST live outside the protocol-independent core and MUST NOT introduce
  client installation as a requirement for using SkillWire.

## Development and Quality Gates

- Every feature specification and implementation plan MUST state how it preserves the remote-only,
  retrieval-only, provenance, privacy, and untrusted-content boundaries.
- Changes to MCP schemas, ranking, version resolution, persistence, source handling, resource
  handling, or repository memory MUST include automated contract and integration coverage.
- Tests for the no-local-install invariant MUST verify that normal, failure, retry, and cache paths
  do not write catalog content or dependencies into client-controlled locations.
- Security-sensitive changes MUST document trust boundaries, authenticated-account scoping,
  rejected inputs, rate-limit behavior, audit events, and cross-tenant failure cases.
- Releases MUST be blocked when provenance is incomplete, published revisions are mutable,
  arbitrary fetch targets are accepted, required isolation tests fail, or retrieval can trigger
  code execution.
- Scope excluded by Principle VIII requires an approved separate specification before related
  implementation begins. A specification cannot waive or weaken this constitution.

## Governance

This constitution governs all SkillWire specifications, plans, tasks, implementation reviews, and
releases. Where another project artifact conflicts with it, this constitution takes precedence.

Amendments MUST be explicit changes to this document and MUST include a rationale, migration plan,
and updated automated tests for every affected contract. Any proposal that weakens a principle,
security boundary, privacy guarantee, or scope gate MUST be approved as a constitution amendment
before dependent implementation is merged. Silent exceptions and implementation-only overrides
are forbidden.

Constitution versions follow semantic versioning:

- MAJOR for a backward-incompatible governance change or the removal or redefinition of a
  principle.
- MINOR for a new principle or section, or a material expansion of existing obligations.
- PATCH for clarifications and non-semantic wording corrections.

Every specification and pull-request review MUST include a constitution compliance check. Reviewers
MUST reject changes that lack required tests, provenance, isolation, privacy, or security evidence.
Before each release, maintainers MUST verify all quality gates in this document and record any
applicable migration resulting from an amendment. Repository memory inspection and erasure paths,
tenant isolation, audit records, immutable revision resolution, and client non-installation MUST be
included in recurring integration verification.

**Version**: 1.0.0 | **Ratified**: 2026-08-11 | **Last Amended**: 2026-08-11
