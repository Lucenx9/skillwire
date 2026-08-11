# Implementation Plan: Remote Skill Delivery MVP

**Branch**: `001-remote-skill-delivery` | **Date**: 2026-08-11 | **Spec**:
[spec.md](./spec.md)

**Input**: Feature specification from `specs/001-remote-skill-delivery/spec.md`

## Summary

Build SkillWire as one strict TypeScript service that exposes six MCP tools over stateless
Streamable HTTP. Hono owns the HTTP edge, application use cases own orchestration, domain modules
own ranking, immutable revision verification, and repository-memory rules, and PostgreSQL adapters
own durable account, API-key, and usage state. The initial catalog is a version-controlled,
allowlisted set of eight to twelve text-only skills packaged with the service. A narrow catalog
provider port permits a future server-configured GitHub provider without changing MCP schemas.

The service never installs or executes catalog content. Search returns previews, load returns core
Markdown plus provenance and a manifest, and resource reads return one validated text resource.
Revision hashes use deterministic canonical serialization over instructions, manifest, and all
resources; each resource also carries its own SHA-256.

## Technical Context

**Language/Version**: Node.js 24.18.x LTS; TypeScript 7.0.x in strict ESM mode

**Primary Dependencies**: pnpm 11; MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.x and
`@modelcontextprotocol/hono` 2.x); Hono 4.x with `@hono/node-server` 2.x; Zod 4.x; `pg` 8.x;
Pino 10.x; RFC 8785-compatible `json-canonicalize` 2.x

**Storage**: PostgreSQL 18.x for accounts, hashed API keys, and repository usage memory; immutable
catalog documents and resources in the version-controlled server catalog; process-local cache only
for already verified immutable catalog bundles

**Testing**: Vitest 4.x projects for unit, MCP contract, PostgreSQL integration, end-to-end, and
security suites; V8 coverage; Docker Compose PostgreSQL for local and CI integration tests

**Target Platform**: Linux OCI container on Node.js active LTS, single service instance plus one
PostgreSQL instance; local development supported directly and through Docker Compose

**Project Type**: Single-package backend service; modular monolith; no frontend and no monorepo

**Performance Goals**: At 25 concurrent clients on the reference Compose environment, p95 under
250 ms for search and repository-memory calls and under 500 ms for verified load/resource calls
from the bundled catalog or verified cache; deterministic search over the full launch catalog

**Constraints**: Stateless MCP transport; request body at most 64 KiB; task description at most
4 KiB UTF-8; instructions at most 256 KiB; each resource at most 256 KiB; at most 64 resources and
2 MiB total normalized content per revision; at most 10 search previews and 100 memory entries per
response; 120 requests per minute per API key with a burst of 30; no caller-supplied URLs, binary
resources, code execution, client writes, sessions, Redis, queues, embeddings, crawlers, or UI

**Scale/Scope**: Eight to twelve curated skills at launch, one current revision preview per skill,
single application instance, one PostgreSQL database, account-wide bearer keys, and repository
memory keyed by account plus a 64-character lowercase repository hash

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Gate | Design evidence | Pre-design | Post-design |
|------|-----------------|------------|-------------|
| Remote delivery, never client installation | MCP responses are the only delivery path; no client filesystem capability exists; security tests snapshot client directories. | PASS | PASS |
| Retrieval, not execution | Catalog accepts validated Markdown and declared text only; no child process, dynamic import, hooks, package manager, or binary path exists. | PASS | PASS |
| Protocol portability | Six operations are MCP tools behind transport-neutral use cases; no harness or ForkTTY dependency is present. | PASS | PASS |
| Immutable provenance | Exact revision and revision hash are mandatory; canonical bundle and per-resource hashes are verified before delivery. | PASS | PASS |
| Private repository memory | The only repository identifier is the client hash; persisted usage is scoped by account and erasable as one transaction. | PASS | PASS |
| Untrusted-content security | Strict schemas, source allowlist, safe paths, byte limits, API-key auth, tenant scoping, rate limits, redacted logs, and security tests are specified. | PASS | PASS |
| Test-backed contracts | MCP schemas, ranking, hashing, version resolution, persistence, isolation, path safety, failure paths, and no-install behavior have dedicated suites. | PASS | PASS |
| Maintainable MVP | One TypeScript service, one PostgreSQL database, one package, one curated provider implementation, and no prohibited expansion. | PASS | PASS |

No constitution exception or complexity waiver is required.

## Project Structure

### Documentation (this feature)

```text
specs/001-remote-skill-delivery/
├── plan.md
├── research.md
├── data-model.md
├── security.md
├── testing-strategy.md
├── quickstart.md
├── deployment.md
├── contracts/
│   ├── mcp-tools.md
│   ├── streamable-http.md
│   └── schemas/
│       ├── common.schema.json
│       ├── search_skills.{input,output}.schema.json
│       ├── load_skill.{input,output}.schema.json
│       ├── read_skill_resource.{input,output}.schema.json
│       ├── list_repo_memory.{input,output}.schema.json
│       ├── record_skill_outcome.{input,output}.schema.json
│       └── forget_repo_memory.{input,output}.schema.json
└── tasks.md                         # Created later by $speckit-tasks
```

### Source Code (repository root)

```text
catalog/
├── catalog.json                     # Allowlisted skill/revision index
└── skills/<skill-id>/<revision>/
    ├── skill.md
    ├── manifest.json
    └── resources/                   # Declared text files only

migrations/
├── 001_accounts_and_api_keys.sql
└── 002_repository_skill_usage.sql

src/
├── application/
│   ├── ports/
│   │   ├── skill-catalog-provider.ts
│   │   ├── repository-memory-store.ts
│   │   └── api-key-store.ts
│   └── use-cases/
│       ├── search-skills.ts
│       ├── load-skill.ts
│       ├── read-skill-resource.ts
│       ├── list-repo-memory.ts
│       ├── record-skill-outcome.ts
│       └── forget-repo-memory.ts
├── domain/
│   ├── catalog/
│   │   ├── canonical-revision.ts
│   │   ├── ranking.ts
│   │   ├── resource-path.ts
│   │   └── types.ts
│   └── repository-memory/
│       ├── outcome.ts
│       └── types.ts
├── transport/
│   └── mcp/
│       ├── app.ts
│       ├── server-factory.ts
│       ├── tool-adapters.ts
│       └── schemas.ts
├── catalog/
│   ├── version-controlled-provider.ts
│   └── verified-revision-cache.ts
├── authentication/
│   ├── api-key-authenticator.ts
│   ├── api-key-token.ts
│   └── middleware.ts
├── persistence/
│   └── postgres/
│       ├── client.ts
│       ├── migration-runner.ts
│       ├── api-key-store.ts
│       └── repository-memory-store.ts
├── observability/
│   ├── audit-events.ts
│   ├── logger.ts
│   ├── redaction.ts
│   └── request-context.ts
├── operations/
│   └── admin-cli.ts                 # Out-of-band account/key lifecycle only
├── composition.ts                   # Only module that wires concrete adapters
├── config.ts
└── main.ts

tests/
├── unit/
├── contract/
├── integration/
├── security/
└── fixtures/catalog/

Dockerfile
compose.yaml
.dockerignore
package.json
pnpm-lock.yaml
tsconfig.json
vitest.config.ts
```

**Structure Decision**: Use one package and one deployable process. Domain modules contain no MCP,
HTTP, PostgreSQL, filesystem, or logging dependencies. Application use cases depend only on domain
types and small ports. MCP, catalog, authentication, PostgreSQL, and logging modules adapt those
ports, and `composition.ts` is the only place that selects concrete implementations. The single
catalog-provider seam is explicitly required for a future GitHub-backed source; no plugin loader or
provider registry is introduced for the MVP.

## Module Dependency Rules

- `transport/mcp` validates MCP inputs and translates results; it never queries PostgreSQL or reads
  catalog files directly.
- `application/use-cases` owns authorization context, orchestration, transaction boundaries, and
  failure mapping; it accepts `accountId` only from authenticated request context.
- `domain/catalog` owns ranking, path rules, canonical serialization, and hash verification.
- `domain/repository-memory` owns usage/outcome invariants and contains no persistence code.
- `catalog`, `authentication`, `persistence`, and `observability` are replaceable adapters selected
  by the composition root, not cross-imported by domain modules.
- The provider port uses skill identity, revision, and logical resource paths—not URLs—so adding a
  server-configured GitHub provider cannot expand the MCP input contracts or create an SSRF path.

## Phase Outputs

- Phase 0 decisions and current documentation evidence: [research.md](./research.md)
- Phase 1 entity and persistence design: [data-model.md](./data-model.md)
- MCP and HTTP contracts: [contracts/](./contracts/)
- Security and privacy decisions: [security.md](./security.md)
- Test architecture and acceptance matrix: [testing-strategy.md](./testing-strategy.md)
- Local validation guide: [quickstart.md](./quickstart.md)
- Container and single-host deployment design: [deployment.md](./deployment.md)

All technical-context questions are resolved. Phase 1 introduces no post-design constitution
violation.
