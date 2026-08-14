# Implementation Plan: Self-Hosted Onboarding and Native Client Integration

**Branch**: `004-self-hosted-onboarding` | **Date**: 2026-08-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-self-hosted-onboarding/spec.md`

## Summary

Add a release-pinned `skillwire` lifecycle CLI that installs one loopback-only Docker Compose deployment, creates one local account with a distinct bearer key per selected client, registers a user-scoped native integration in Codex and/or Claude Code, and supports status, doctor, repair, backup, upgrade, selective uninstall, and separately confirmed permanent removal. Mutations are previewed, journaled, independently compensatable per client, ownership-bounded, and recoverable after interruption.

The client-facing transport is a minimal STDIO-to-Streamable-HTTP MCP bridge launched by the ordinary clients. It reads a client-specific key from Linux Secret Service through `secret-tool`, or from a separately confirmed `0600` fallback, injects the bearer header only in memory, validates the unchanged six-tool upstream contract, and exits promptly without retry on failure. Release-local activation plugins supply only the bounded Feature 003 activation policy and its allowlisted static package metadata; remote catalog instructions continue to cross the client boundary only as transient MCP responses.

## Technical Context

**Language/Version**: TypeScript 6.0.3 on a release-pinned Node.js 24.18.x runtime; Markdown, JSON, YAML, TOML, and Compose artifacts

**Primary Dependencies**: Existing Hono, Zod 4.4.3, PostgreSQL client, Pino, YAML, `@modelcontextprotocol/client` and `@modelcontextprotocol/server` 2.0.0; Node standard `crypto`, `fs`, `child_process`, and stream APIs; Docker Engine/Compose and vendor Codex/Claude CLIs as external managed interfaces; optional `/usr/bin/secret-tool` as the Secret Service frontend; release-pinned Cosign 3.1.3 for keyless signing and offline Sigstore bundle verification

**Storage**: Existing PostgreSQL 17 persistent volume and migrations 001-010; XDG configuration/data/state/cache roots; independent create-only `0600` database/application secret files below a `0700` user data directory; Linux Secret Service or client-specific restrictive credential files; client-managed user profiles and plugin caches; protected logical backup sets

**Testing**: Vitest 4.1.10 unit/contract/integration/e2e/security/evaluation projects, Testcontainers PostgreSQL, Docker Compose fixtures, disposable HOME/XDG profiles, fake helpers plus a real isolated D-Bus/Secret Service session, pinned Codex 0.147.0 and Claude Code 2.1.229 lifecycle probes, dispatcher signal/exit/bridge-routing tests, deterministic 10-second bridge deadline tests, informational setup-duration evidence, signing/trust-policy fault tests, fault injection, canary secret scanning, and supported OS/architecture release jobs

**Target Platform**: 64-bit Ubuntu 24.04 LTS and Debian 12/13 on `amd64` and `arm64`; local Docker Engine 29.x with Compose 5.x, including an already functional rootless context

**Project Type**: One modular TypeScript service plus a self-contained user-scoped lifecycle CLI/MCP bridge and two optional client adapter packages; one Compose deployment, not a new service tier

**Performance Goals**: A supported first installation with one client completes within 15 minutes, measured as informational usability/release evidence rather than a participant-timing CI gate; deterministic tests enforce that bridge credential resolution plus upstream initialization either completes or fails within the clients' 10-second end-to-end startup budget; activation performs no retries; existing service request and evaluation targets remain unchanged

**Constraints**: No root by default, Docker installation, repository writes, wrapper client commands, alternate normal-user client profiles, shell-startup edits, raw secrets in arguments/environment/output/config/backups, long-lived repository/release signing keys, local catalog-skill installation, arbitrary content execution, unverified or downgraded releases/trust policies, remote Docker contexts, destructive repair, or unsafe rollback across migration 010

**Scale/Scope**: One local installation, one SkillWire account, zero to two selected clients, one active key per owned client integration, one PostgreSQL volume, ten first-party launch skills, the exact six MCP tools, and optional explicitly selected curated sources

## Constitution Check

*GATE: Passed before Phase 0 research and re-checked after Phase 1 design.*

| Principle/gate | Pre-research assessment | Post-design evidence |
|----------------|-------------------------|----------------------|
| I. Remote Delivery, Never Client Installation | Pass: onboarding installs transport and bounded activation metadata, never catalog skills/resources. | Client contracts prohibit catalog content in plugins, profiles, release adapters, or repositories; zero-write and inventory tests remain release gates. |
| II. Retrieval, Not Arbitrary Execution | Pass: existing service returns validated inert text and onboarding does not execute imported content. | The bridge forwards only the existing MCP operations; imported scripts/hooks remain data and release-local plugins contain instruction-only activation policy. |
| III. Protocol Portability | Pass: the Streamable HTTP MCP service stays authoritative and usable without either adapter. | The STDIO bridge is an optional transport adapter; no core operation, schema, ranking, memory, or auth rule depends on Codex or Claude. |
| IV. Immutable Provenance | Pass: setup uses the existing immutable catalog and validates release identity first. | The signed release manifest binds images, Compose, catalog, advisories, migrations, CLI/runtime, plugins, and marketplaces by digest; smoke loads assert exact revision/hash/provenance/advisory. |
| V. Private Repository Memory | Pass: no new repository input or persistence is required. | Existing opaque account-scoped memory tables remain unchanged; onboarding stores no repository path/hash and tests digest the active repository before and after every lifecycle operation. |
| VI. Untrusted-Content Security | Pass: release inputs, paths, profiles, sources, archives, and endpoints are treated as untrusted. | Design validates signatures/digests, loopback destinations, ownership, modes, links, stale snapshots, source allowlists, bounded outputs, deadlines, and redaction before mutation. |
| VII. Test-Backed Contracts | Pass if every lifecycle, secret, bridge, client, and recovery boundary gains automated coverage. | Phase 1 defines versioned CLI/bridge/client/release contracts and requires all Feature 001-003 suites plus Feature 004 acceptance, fault, preservation, and leak tests. |
| VIII. Maintainable MVP | Pass: Feature 004 is the approved separate specification for lifecycle/client-adapter scope and keeps one modular service. | New code is isolated behind onboarding and bridge modules; there is no web UI, SaaS, marketplace service, OAuth, microservice, or arbitrary repository ingestion. |

Security review gates also pass: trust boundaries, authenticated account scoping, rejected inputs, rate-limit/failure behavior, audit-safe findings, and tenant-preserving existing MCP behavior are explicit in [research.md](./research.md), [data-model.md](./data-model.md), and the contracts.

## Project Structure

### Documentation (this feature)

```text
specs/004-self-hosted-onboarding/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── administrative-cli.md
│   ├── client-integration.md
│   ├── credential-bridge.md
│   ├── release-and-recovery.md
│   └── service-secrets.md
└── tasks.md                  # Created later by $speckit-tasks
```

### Source Code (repository root)

```text
src/
├── onboarding/
│   ├── cli/
│   │   ├── main.ts
│   │   ├── command-router.ts
│   │   ├── output.ts
│   │   └── confirmation.ts
│   ├── secrets/
│   │   └── service-secrets.ts
│   ├── domain/
│   │   ├── installation.ts
│   │   ├── ownership.ts
│   │   ├── operation-journal.ts
│   │   ├── release-manifest.ts
│   │   ├── diagnostics.ts
│   │   ├── profile-snapshot.ts
│   │   └── source-choice.ts
│   ├── application/
│   │   ├── setup.ts
│   │   ├── client-lifecycle.ts
│   │   ├── client-credentials.ts
│   │   ├── client-verification.ts
│   │   ├── activation-diagnostic.ts
│   │   ├── profile-transaction.ts
│   │   ├── service-secret-rotation.ts
│   │   ├── status.ts
│   │   ├── diagnostic-probes.ts
│   │   ├── doctor.ts
│   │   ├── recovery.ts
│   │   ├── backup.ts
│   │   ├── upgrade.ts
│   │   ├── upgrade-recovery.ts
│   │   ├── repair.ts
│   │   ├── uninstall.ts
│   │   ├── purge.ts
│   │   ├── first-party-catalog.ts
│   │   └── source-bootstrap.ts
│   └── adapters/
│       ├── clients/
│       │   ├── codex.ts
│       │   ├── claude.ts
│       │   └── client-state.ts
│       ├── credentials/
│       │   ├── secret-tool.ts
│       │   ├── restrictive-file.ts
│       │   └── github-token.ts
│       ├── docker/
│       │   ├── deployment.ts
│       │   └── writer-drain.ts
│       ├── filesystem/
│       │   ├── safe-paths.ts
│       │   ├── atomic-state.ts
│       │   ├── release-verifier.ts
│       │   └── release-installer.ts
│       ├── process/
│       │   └── command-runner.ts
│       └── postgres/
│           ├── service-database.ts
│           ├── bootstrap-admin.ts
│           ├── backup.ts
│           └── schema-compatibility.ts
├── credential-bridge/
│   ├── bridge-cli.ts
│   ├── bridge-errors.ts
│   ├── credential-resolver.ts
│   ├── upstream-client.ts
│   └── stdio-server.ts
└── authentication/
    └── admin-cli.ts           # Extended with a private key-output channel

integrations/
├── codex/skillwire-autonomous-activation/
└── claude/skillwire-autonomous-activation/

distribution/
├── self-hosted/
│   ├── compose.yaml
│   ├── release-manifest.schema.json
│   ├── trust-policy.schema.json
│   ├── trust-policy.v1.json
│   └── README.md
├── codex-marketplace/
└── claude-marketplace/

scripts/
├── build-self-hosted-release.ts
├── sign-self-hosted-release.ts
└── verify-self-hosted-release.ts

.github/workflows/
└── self-hosted-release.yml

tests/
├── unit/
│   ├── onboarding/
│   └── credential-bridge/
├── contract/
│   ├── cli/
│   ├── clients/
│   ├── credential-bridge/
│   └── release/
├── integration/
│   └── onboarding/
├── e2e/
│   └── self-hosted-onboarding/
└── security/
    └── onboarding/
```

**Structure Decision**: Keep the protocol-independent service in the current single TypeScript project. Add a cohesive `src/onboarding` vertical slice, an explicit `src/onboarding/cli/main.ts` dispatcher, a dedicated `src/onboarding/secrets/service-secrets.ts` boundary, and a separate `src/credential-bridge` adapter, all shipped in one architecture-specific release archive with a pinned Node runtime. Client packages remain static instruction-only integrations under `integrations/`; production Compose, trust policy, release metadata, and operator bootstrap documentation remain distribution artifacts. No production database migration is required because existing account, API-key, catalog, source, and repository-memory tables remain authoritative.

## Implementation Sequence

1. Define tests, then validate release/trust-policy, ownership, journal, CLI-result, service-secret, and diagnostic schemas before implementing mutations.
2. Build safe filesystem/XDG, subprocess, redaction, lock, service-secret, signed-artifact verification, and Secret Service/fallback primitives with fault and leak tests, including a real isolated Secret Service session.
3. Implement the real CLI dispatcher and private one-shot API-key channel, then add the validated STDIO credential bridge; prove exact authenticated six-tool forwarding, end-to-end 10-second deadline, signal cancellation, and fail-open behavior.
4. Implement immutable production Compose installation, readiness, first account/key lifecycle, first-party catalog verification, and optional source bootstrap.
5. Implement Codex then Claude reconciliation through vendor CLIs, independent client transactions, release-local activation plugins, fresh-process deterministic verification, and separate automatic diagnostics.
6. Add status/doctor/repair, restore-validated backup, migration-aware upgrade/rollback, default uninstall, and separately confirmed permanent removal.
7. Sign the canonical release manifest in the pinned GitHub tag workflow using keyless OIDC, verify its Sigstore bundle and versioned trust policy offline, then run the full supported matrix, all 28 numbered Feature 004 scenarios, duration evidence, secret canary/interruption sweeps, and every unchanged Feature 001-003 gate before publication.

## Complexity Tracking

No constitutional violations require justification.
