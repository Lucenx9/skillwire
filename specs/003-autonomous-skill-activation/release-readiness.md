# Feature 003 Release Readiness

**Branch**: `003-autonomous-skill-activation`
**Recorded**: 2026-08-12
**Status**: deterministic implementation gates pass; optional real-harness evidence is valid but does not meet the spontaneous-activation target

## Deterministic gates

| Gate | Result |
|------|--------|
| Prettier full configured surface | Pass |
| Type-aware ESLint | Pass |
| Strict TypeScript typecheck | Pass |
| Production TypeScript build | Pass |
| `test:activation` | Pass: 12 files, 69 tests |
| Unit regressions | Pass: 26 files, 134 tests |
| Contract regressions | Pass: 14 files, 91 tests |
| PostgreSQL integration regressions | Pass: 19 files / 52 tests; the credential-gated live GitHub smoke remains skipped by design |
| E2E regressions | Pass: 8 files, 31 tests |
| Evaluation regressions | Pass: 5 files, 7 tests |
| Security regressions | Pass: 9 files, 53 tests |
| Frozen benchmark inputs | Pass |
| Launch catalog integrity | Pass: 10 exact revisions |
| Release-anchored advisory integrity | Pass: 10 events |
| `git diff --check` | Pass |

The focused gate is deterministic and offline. It uses no model, harness credential, live GitHub request, or manual evidence collection. It verifies both MCP protocol eras, the unchanged six-tool schemas, exact descriptions and annotations, automatic/user-requested filtering, positive relevance, real registered MCP call sequences, failure stops, verified-load attribution, PostgreSQL tenant scoping, zero agent-facing GitHub calls, and unchanged temporary client trees.

## Container boundaries

- Compose base and test-overlay configuration validation passed.
- The production runtime image built successfully from the frozen lockfile.
- Runtime UID is `10001`.
- `typescript`, `tsx`, and `vitest` are absent from the production image.
- Startup without required configuration exits nonzero with a bounded lifecycle event.
- PostgreSQL-backed integration and E2E suites passed against disposable databases.

## Compatibility and scope audit

- MCP operation count remains exactly six; no names, titles, input schemas, output schemas, handlers, or error envelopes were added or removed.
- No database migration was added; migrations remain `001` through `008`.
- No client file, local skill, repository activation file, UI integration, launcher, dashboard, semantic embedding, source-curation behavior, or GitHub discovery path was added.
- No file under `specs/001-remote-skill-delivery/` or `specs/002-github-catalog-ingestion/` changed.
- Agent-facing MCP composition still has no GitHub client and no client-path/write capability.
- Existing authentication, account/tenant predicates, provenance, advisory, integrity, rate-limit, erasure, and no-client-write behavior remains covered by the complete regression projects.

## Enforcement boundary

The server enforces supplied-context filtering, positive relevance, exact verified load identity, provenance/integrity/advisory checks, declared resource safety, optional opaque-hash memory attribution, authentication, tenancy, rate limits, and safe errors. Server instructions and tool annotations advise once-per-task activation, local precedence, explicit conversational intent, progressive ordering, no retry, fail-open continuation, and positive-outcome evidence. The stateless server does not claim it can force an arbitrary MCP harness to invoke tools or follow those advisory rules.

## Manual harness evidence

The offline evidence validator and CLI pass their valid, incomplete, and deliberately invalid fixtures. They recompute metrics from ordered per-case traces and reject privacy leaks, sequence/loop violations, local override, unsupported positive outcomes, and unverifiable SkillWire attribution.

The privacy-safe candidate is `evaluation/evidence/003/candidate-v1.json`. It records:

- Codex CLI `0.147.0`, model `gpt-5.6-sol`, reasoning `xhigh`, and MCP `2026-07-28`;
- SkillWire base commit `ed4a21660a5f58b3ff33b123d898d87fe1f2097e`, candidate diff SHA-256 `f03a840b2dacd2d8c86f579d319437572f47236f0f9471ce4bcb4c9e0f737fe9`, and image `sha256:d48cf87a981acf04f5c211ce38c09687cda04128ef8cf4e22ac9846d7e5ed54e`;
- policy `skillwire-activation-v1`, corpus `autonomous-activation-v1`, and exact instruction SHA-256 `d1e923bf6c80b6c41070cc6ffc1678e6caa738f1427ac2e9dfda6c00ceb1091e`.

The probe used disposable mode-`0700` `HOME`, `CODEX_HOME`, and empty Git repository directories outside the SkillWire hierarchy. A mode-`0600` temporary Codex authentication copy and inherited SkillWire bearer environment variable were the only credentials. User configuration was ignored; plugins, skill search, apps, and workspace dependencies were disabled. Inventory checks found only the configured `skillwire` MCP server and the unavoidable Codex system skills `imagegen`, `openai-docs`, `plugin-creator`, `skill-creator`, and `skill-installer`; no user, repository, admin, plugin, or competing engineering skill was present.

An observer proxy proved `server/discover` returned the exact instructions and the exact six-tool inventory for every observation. Seven completed specialized cases spanning threat modeling, TypeScript review, Node API design, PostgreSQL review, React accessibility, Vitest design, and Dockerfile hardening made zero SkillWire operations. An eighth GitHub Actions case was stopped and marked incomplete after excessive model latency, with no SkillWire operation observed. Every client-tree digest remained unchanged and no agent-facing GitHub request occurred.

The validator reports spontaneous activation `0/7` (`0%`). Seven completed misses make the full 30-case clean-cohort target mathematically unreachable: even if all 23 remaining cases activated, the maximum would be `23/30` (`76.7%`), below the required `80%`. The artifact passes the normative Draft 2020-12 JSON Schema and the offline semantic validator/metric recomputation, with status `incomplete` and diagnostics `EXPECTED_SEARCH_MISSING` and `INCOMPLETE_TRACE`.

Task T046 therefore remains unchecked. The exact blocker is a measured acceptance failure in this pinned Codex harness/model: the server published the required decision surface, but the harness made no spontaneous calls. No server-side contract defect, client contamination, fabricated call, or successful activation claim was found. This result remains non-blocking for deterministic CI.
