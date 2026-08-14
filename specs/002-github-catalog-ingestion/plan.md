# Implementation Plan: GitHub Catalog Ingestion

**Branch**: `002-github-catalog-ingestion` | **Date**: 2026-08-11 | **Spec**:
[`spec.md`](spec.md)

**Input**: Feature specification from `specs/002-github-catalog-ingestion/spec.md`

## Summary

Extend the existing SkillWire modular monolith with an asynchronous, administrator-controlled
pipeline that discovers and registers public GitHub repositories, resolves each synchronization to
an exact commit, reads only bounded Git objects through GitHub REST, validates inert textual skills,
and atomically publishes eligible imports as immutable PostgreSQL-backed revisions. Agent-facing
search never performs GitHub work; it merges the unchanged Feature 001 catalog with verified or
curated imported revisions and preserves exact load, progressive resource delivery, repository
memory, advisory, authentication, deadline, logging, and no-client-write behavior.

The GitHub adapter will use Node.js 24 native `fetch` rather than Octokit. A narrow client is smaller
for the six fixed read-only endpoint families and can enforce validated manual redirect handling,
one official API origin, streamed byte caps, shared deadlines, deterministic pagination, bounded
retries, ETags, and rate-limit headers without bringing App, OAuth, GraphQL, webhook, or
Redis-oriented throttling features into the monolith.

## Technical Context

**Language/Version**: Node.js 24 and TypeScript 6 in existing strict mode

**Primary Dependencies**: Existing Hono 4, MCP SDK v2, Zod 4, `pg` 8, and Pino 10; Node.js native
`fetch` for GitHub REST; add only `yaml` for constrained YAML 1.2 frontmatter and
`mdast-util-from-markdown` for bounded CommonMark link extraction

**Storage**: Existing version-controlled Feature 001 catalog remains unchanged; PostgreSQL is
authoritative for GitHub sources, jobs, leases, immutable imported bundles, policy history, and
external advisories

**Testing**: Existing Vitest projects, PostgreSQL Testcontainers, deterministic recorded GitHub REST
fixtures in required CI, and an optional manual live-GitHub smoke test

**Target Platform**: Existing Linux container and Docker Compose deployment

**Project Type**: One modular TypeScript MCP service with in-process lifecycle schedulers and
administrator CLIs

**Performance Goals**: No network or ingestion work on agent requests; preserve existing search
evaluation thresholds; at least 95% of accepted in-budget registrations/synchronizations reach a
deterministic published or quarantined result within five minutes under normal GitHub availability

**Constraints**: Public `github.com` only; fixed `https://api.github.com` REST origin; exact
40-character commit pins; no clone, checkout, execution, content-derived network target, separate
worker service, Redis, or queue; bounded requests, pages, tree entries, candidates, resources,
dependencies, bytes, retries, and wall time; create-only atomic publication

**Scale/Scope**: Acceptance repository contains 25 manifest-declared skills; design defaults support
up to 256 candidates per bounded repository snapshot, 64 resources per skill, 32 required internal
dependencies per skill, 20,000 tree entries, and 32 MiB of decoded repository content while retaining
the existing 256 KiB per-text-object and 2 MiB per-revision limits

## Constitution Check

*GATE: Passed before Phase 0 research and re-checked after Phase 1 design.*

| Principle or gate | Design evidence | Result |
| --- | --- | --- |
| I. Remote Delivery | Imported bundles remain server-side and are exposed only through the existing MCP search, load, and resource operations; client-tree tests cover every path. | PASS |
| II. Retrieval, Not Execution | The GitHub reader accepts only regular non-executable text blobs and never clones, runs hooks, invokes package managers, or executes repository content. | PASS |
| III. Protocol Portability | Agent behavior remains in the six MCP tools; administration is an operator CLI and is not tied to an agent harness. | PASS |
| IV. Immutable Provenance | Canonical schema v2 binds exact source commit, content, license, dependencies, resources, and hashes; PostgreSQL tables and publication are create-only. | PASS |
| V. Private Repository Memory | Existing account/repository-scoped memory is unchanged and imported catalog tables store no client repository data. | PASS |
| VI. Untrusted-Content Security | Fixed-origin REST, safe object modes and paths, strict parsers, size budgets, deterministic policy, quarantine, redaction, and cancellation are specified in [`security.md`](security.md). | PASS |
| VII. Test-Backed Contracts | Backward-compatible MCP contracts, CLI contracts, recorded fixtures, PostgreSQL integration, adversarial security, no-write, and acceptance suites are specified. | PASS |
| VIII. Maintainable MVP | All components remain modules in one service with PostgreSQL coordination; no frontend, microservice, Redis, marketplace, or arbitrary crawler is introduced. | PASS |

Post-design re-evaluation found no constitutional violation or unresolved clarification. The unified
provider preserves Feature 001 as a separate verified input, canonical v1 bytes are not reserialized,
and GitHub availability does not become an MCP readiness dependency.

## Architectural Decisions

1. `GitHubRestClient` owns all URL construction, validated same-origin repository-rename handling,
   retry, pagination, ETag, rate-limit, body-size, and cancellation behavior. Callers pass typed
   owner/repository/object identifiers, never URLs.
2. Source discovery and synchronization are application services. Hono/MCP transport has no import
   or registration route, and `search_skills` never invokes those services.
3. PostgreSQL lease rows use monotonic fencing tokens. Network and parsing occur outside database
   transactions; the final short publication transaction validates the live lease immediately
   before atomically advancing the source head.
4. Plugin manifests are authoritative when present. Otherwise, a bounded nested `SKILL.md` adapter
   discovers candidates. Both feed one safe parser, license validator, dependency resolver, and
   policy engine.
5. Imported revisions use a new canonical schema v2. Feature 001 canonical schema v1 and catalog
   verification remain byte-for-byte and module-level unchanged.
6. An asynchronous `UnifiedSkillCatalogProvider` combines a promise-adapted first-party provider
   with direct PostgreSQL reads of the current imported catalog. The externally observable Feature
   001 responses remain valid, while imported responses use additive discriminated metadata.
7. Verified means automated structural/provenance/integrity validation only. Current classification
   and advisory state are projections separate from immutable `trustAtPublication`.

Detailed decisions are in [`research.md`](research.md), the persistence design is in
[`data-model.md`](data-model.md), and lifecycle behavior is in
[`ingestion-state-machine.md`](ingestion-state-machine.md).

## Project Structure

### Documentation (this feature)

```text
specs/002-github-catalog-ingestion/
├── plan.md
├── research.md
├── data-model.md
├── security.md
├── ingestion-state-machine.md
├── testing-strategy.md
├── migration-plan.md
├── operational-synchronization.md
├── quickstart.md
├── contracts/
│   ├── admin-cli.md
│   ├── github-provider.md
│   └── mcp-tools.md
└── checklists/
    └── requirements.md
```

`tasks.md` is intentionally deferred to `$speckit-tasks`.

### Source Code (repository root)

```text
src/
├── application/
│   ├── ports/
│   │   ├── external-catalog-store.ts
│   │   ├── github-source-provider.ts
│   │   └── sync-lease-store.ts
│   ├── services/
│   │   ├── source-discovery-service.ts
│   │   ├── source-registration-service.ts
│   │   └── source-synchronization-service.ts
│   └── use-cases/                       # existing MCP use cases, additive input/output support
├── catalog/
│   ├── unified-provider.ts
│   └── version-controlled-provider.ts   # existing Feature 001 implementation retained
├── domain/
│   └── external-catalog/
│       ├── canonical-revision-v2.ts
│       ├── candidate-policy.ts
│       ├── dependency-resolver.ts
│       ├── license-validator.ts
│       └── types.ts
├── ingestion/
│   ├── admin-cli.ts
│   ├── github/
│   │   ├── commit-tree-blob-reader.ts
│   │   ├── discovery-provider.ts
│   │   └── rest-client.ts
│   └── parsing/
│       ├── claude-plugin-manifest.ts
│       ├── frontmatter.ts
│       ├── markdown-resources.ts
│       └── nested-skill-layout.ts
├── lifecycle/
│   └── github-sync-scheduler.ts
├── persistence/postgres/
│   ├── external-catalog-provider.ts
│   ├── external-catalog-store.ts
│   ├── github-source-store.ts
│   └── sync-lease-store.ts
└── transport/mcp/                       # additive schemas; same six tool names

migrations/
├── 004_github_sources_and_jobs.sql
├── 005_external_catalog_revisions.sql
└── 006_external_policy_and_advisories.sql

tests/
├── contract/
│   ├── mcp/
│   └── source-cli/
├── e2e/
├── evaluation/
├── fixtures/github-ingestion/
├── integration/postgres/
├── security/github-ingestion/
└── unit/external-catalog/
```

**Structure Decision**: Extend the current modular monolith along its existing application, domain,
persistence, lifecycle, transport, and catalog boundaries. GitHub-specific code stays under
`src/ingestion`; policy and canonical identity stay protocol-independent; PostgreSQL is accessed
through ports; the existing first-party publisher/verifier entrypoints do not import ingestion
writers.

## Incremental Implementation Plan

1. Add contract-first domain types, canonical schema v2, additive migrations, and immutable-table
   enforcement while proving Feature 001 still runs against the upgraded schema.
2. Build the fixed-origin native-fetch GitHub adapter and deterministic fixture harness, then add
   exact repository/ref/commit/tree/blob acquisition with all budgets and cancellation.
3. Implement the manifest and nested-layout adapters, safe frontmatter/Markdown parsers, license and
   attribution validation, dependency resolution, stable findings, and quarantine policy.
4. Implement fenced source registration, discovery/synchronization services, atomic publication,
   external advisories, scheduler lifecycle, and the separate administrator CLI.
5. Add the asynchronous PostgreSQL imported provider and unified deterministic search/load/resource
   behavior, including invocation context and backward-compatible external metadata.
6. Complete contract, PostgreSQL, security, acceptance, evaluation, no-client-write, restart,
   cancellation, and optional live-GitHub validation; update operational documentation and run all
   existing Feature 001 gates.

## Complexity Tracking

No constitutional violations require justification.
