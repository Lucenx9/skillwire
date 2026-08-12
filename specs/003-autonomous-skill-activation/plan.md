# Implementation Plan: Autonomous Skill Activation

**Branch**: `003-autonomous-skill-activation` | **Date**: 2026-08-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-autonomous-skill-activation/spec.md`

## Summary

Retain the implemented, centralized `ServerOptions.instructions` policy and refined metadata as the client-agnostic advisory baseline, while treating the preserved Codex CLI `0/7` result as evidence that this server-only surface is insufficient for the tested harness. Add one optional user-scoped Codex plugin distributed through a configured SkillWire marketplace. The plugin contains exactly one narrowly described, implicitly invocable activation skill and one official skill-level MCP dependency declaration; it contains no remote skill content, executable payload, credential, repository state, or custom lifecycle code.

Codex's plugin manager—not SkillWire application code—configures the marketplace and installs, refreshes, verifies, and removes the adapter. The server remains independently usable through the same six MCP operations. Required CI deterministically validates the server, plugin package, marketplace metadata, lifecycle, security boundaries, frozen 75-case corpus, the outcome-independent 15-case stratified pilot, and Feature 001/002 compatibility. Real-model server-only and adapter-assisted measurements remain non-blocking. The pilot can support only a qualified release-candidate observation after the adapter cohort reaches the 80% target with attributable `search_skills -> load_skill` traces; it is not a statistically definitive activation estimate. The 30-case pair becomes an optional extended benchmark and the 65-case pair an optional expanded benchmark.

## Technical Context

**Language/Version**: TypeScript 6.0.3 on Node.js 24+; Markdown/YAML/JSON for the Codex plugin package

**Primary Dependencies**: Existing MCP SDK 2.0.0 stack and Hono/Zod/PostgreSQL dependencies; Codex CLI/plugin manager `0.147.0` pinned for lifecycle compatibility tests; no runtime adapter library

**Storage**: Existing catalog and PostgreSQL repository-memory tables; Codex-managed user plugin cache/configuration only; no database migration

**Testing**: Vitest 4.1.10, official MCP client, in-process HTTP handler, Testcontainers PostgreSQL, JSON Schema/YAML validation, and isolated real Codex plugin-manager commands without model calls

**Target Platform**: Client-agnostic Streamable HTTP MCP service plus one optional user-scoped Codex plugin integration; no IDE, UI, graphical-interface, or launcher integration

**Project Type**: Existing modular TypeScript service plus a static three-file integration package

**Performance Goals**: Preserve existing server latency and response bounds; adapter adds no process, hook, polling loop, or call beyond the one-attempt policy

**Constraints**: Exactly six MCP tools; no schema changes, migrations, `.mcp.json`, `.app.json`, hooks, scripts, assets, client-repository files, remote-skill installation, embedded secrets, UI code, or SkillWire writes to Codex-managed paths

**Scale/Scope**: Existing frozen 75-case activation corpus; one immutable 15-case 8/3/2/2 release-candidate pilot; one plugin identity, one skill, one MCP dependency, one marketplace entry, one server-only baseline artifact, and paired pilot evidence

## Constitution Check

### Pre-design gate

| Principle | Result | Design evidence |
|-----------|--------|-----------------|
| I. Remote Delivery, Never Client Installation | PASS | Catalog skills/resources remain transient MCP data and are never installed. The optional adapter contains activation guidance only, is not required for explicit/core operation, and is installed solely by Codex at user scope. |
| II. Retrieval, Not Arbitrary Execution | PASS | The adapter has no scripts, hooks, binaries, dependencies to execute, or remote skill content. Existing server retrieval remains inert text. |
| III. Protocol Portability | PASS | The six-tool MCP server and standard instructions remain complete without the Codex adapter. The plugin is a separate thin harness integration. |
| IV. Immutable Provenance | PASS | Search preview, exact verified load, provenance, advisory, hash, and declared resource behavior remain unchanged. |
| V. Private Repository Memory | PASS | The adapter has no repository-hash field or memory behavior. Existing opaque-hash memory remains attributable only after verified load. |
| VI. Untrusted-Content Security | PASS | Plugin artifacts contain no credentials or remote skill payload. Auth, tenant, integrity, advisory, path, size, and rate controls remain server-enforced. |
| VII. Test-Backed Contracts | PASS | Offline gates cover both MCP eras, plugin/marketplace schemas, actual manager lifecycle, real MCP call traces, failures, zero writes, and Feature 001/002 regressions. |
| VIII. Maintainable MVP | PASS | This feature's approved adapter is one static plugin and marketplace entry, not a marketplace service, dashboard, crawler, installer, or UI. |

No constitution exception is required. The optional plugin does not make client installation a prerequisite for explicit SkillWire use and does not materialize catalog content.

## Project Structure

### Documentation (this feature)

```text
specs/003-autonomous-skill-activation/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── spec.md
├── checklists/
│   └── requirements.md
└── contracts/
    ├── activation-corpus.schema.json
    ├── activation-release-subset.schema.json
    ├── codex-activation-plugin.md
    ├── manual-evidence.schema.json
    ├── paired-adapter-evidence.schema.json
    └── mcp-activation.md
```

### Source and release artifacts

```text
src/
├── application/use-cases/load-skill.ts
├── domain/catalog/ranking.ts
├── evaluation/
│   ├── activation-corpus-runner.ts
│   ├── activation-evidence.ts
│   └── codex-adapter-package.ts            # new offline package validator
└── transport/mcp/
    ├── activation-policy.ts
    ├── server-factory.ts
    └── tool-adapters.ts

integrations/codex/
└── skillwire-autonomous-activation/         # package source; never installed by app code
    ├── .codex-plugin/plugin.json
    └── skills/autonomous-skill-activation/
        ├── SKILL.md
        └── agents/openai.yaml

distribution/codex-marketplace/
├── marketplace.json                        # release input for a dedicated marketplace repo
└── release-integrity.json                   # package version, source commit, file hashes

evaluation/
├── autonomous-activation.v1.json            # existing immutable 75-case corpus
├── autonomous-activation-release-subset.v1.json # frozen 15-case RC pilot
└── evidence/003/
    ├── candidate-v1.json                    # immutable 0/7 server-only baseline
    └── adapter-pair-v1.json                  # fresh matched runs; created only when complete

tests/
├── contract/cli/codex-activation-plugin.test.ts
├── e2e/autonomous-activation-transport.test.ts
├── evaluation/autonomous-activation.test.ts
├── security/transport/autonomous-activation-boundaries.test.ts
└── unit/evaluation/
    ├── activation-corpus.test.ts
    ├── codex-adapter-package.test.ts
    └── manual-evidence.test.ts
```

**Structure Decision**: Keep all protocol-independent behavior in the existing service. Store the reviewable plugin source under `integrations/codex`, outside `.agents`, `.codex`, and every repository auto-discovery path. `distribution/codex-marketplace/marketplace.json` is a publication input, not a repository-scoped Codex configuration; release promotion publishes it as `.agents/plugins/marketplace.json` at the root of a dedicated configured marketplace repository. SkillWire runtime code never copies either artifact into a client directory.

## Existing Work Disposition

### Remains valid and should not be rewritten

- `src/transport/mcp/activation-policy.ts`, `server-factory.ts`, and `tool-adapters.ts`: centralized policy, legacy/current exposure, six-tool descriptions, and annotations remain the portable baseline.
- `src/domain/catalog/ranking.ts` and `src/application/use-cases/load-skill.ts`: relevance threshold, isolation, exact verified-load attribution, and memory ordering remain valid.
- `evaluation/autonomous-activation.v1.json` and `contracts/activation-corpus.schema.json`: reuse the frozen 75 cases unchanged. Derive and validate the separate 15-case 8/3/2/2 pilot strictly from source-corpus order; never choose from observed model outcomes.
- Existing metadata, ranking, transport, memory, no-GitHub, no-client-write, and Feature 001/002 regression tests.
- `contracts/mcp-activation.md`: server contract remains authoritative; revise only wording that implies server-only autonomous success.
- `contracts/manual-evidence.schema.json` and `evaluation/evidence/003/candidate-v1.json`: retain v1 validation and the exact baseline bytes. Baseline SHA-256 is `04cd236d6ddd27f30c21f7d332577ef3a91a3f55fc6ab79d1fd1f02d4900db2d`.

### Requires revision without discarding compatible behavior

- `src/evaluation/activation-evidence.ts`, `scripts/activation-evidence.ts`, and their tests: add a paired-evidence envelope while continuing to validate existing v1 evidence.
- `docs/autonomous-activation-evaluation.md`, `README.md`, `docs/operations.md`, and `docs/privacy.md`: document the falsified server-only hypothesis, optional plugin lifecycle, ownership boundaries, and two evaluation conditions.
- `.github/workflows/ci.yml` and `package.json`: add offline package/marketplace/lifecycle validation using a pinned Codex manager, without model calls or credentials.
- Feature 003 plan/research/data-model/quickstart/contracts: add official Codex structures and adapter boundaries.

### New files

- The three plugin files under `integrations/codex/skillwire-autonomous-activation/`.
- `distribution/codex-marketplace/marketplace.json` and `release-integrity.json`.
- `contracts/codex-activation-plugin.md` and `contracts/paired-adapter-evidence.schema.json`.
- `evaluation/autonomous-activation-release-subset.v1.json` and `contracts/activation-release-subset.schema.json`.
- `src/evaluation/codex-adapter-package.ts` and focused unit/CLI lifecycle tests.

Features 001 and 002 artifacts are not modified.

## Architecture and Design

### 1. Portable server baseline

Keep `ACTIVATION_POLICY_VERSION = "skillwire-activation-v1"` and the implemented `ServerOptions.instructions` value as the single server policy. Legacy `initialize` and modern `server/discover` must remain semantically and byte-for-byte identical. Tool descriptions and annotations remain additive hints. Documentation must state that this metadata was delivered correctly yet produced `0/7` spontaneous activations in the preserved tested Codex profile; it cannot force arbitrary harness behavior.

### 2. Minimal official Codex plugin

The exact package inventory is three regular UTF-8 files:

1. `.codex-plugin/plugin.json` with stable name `skillwire-autonomous-activation`, semantic version beginning at `0.1.0`, description, and `"skills": "./skills/"`.
2. `skills/autonomous-skill-activation/SKILL.md` with `name` and a front-loaded, narrow `description`, followed by the bounded activation workflow. It contains activation guidance only.
3. `skills/autonomous-skill-activation/agents/openai.yaml` with minimal `interface`, `policy.products: [CODEX]`, explicit `allow_implicit_invocation: true`, and one `dependencies.tools` MCP entry named `skillwire` with `transport: streamable_http` and the release's canonical credential-free HTTPS endpoint.

Do not add `.mcp.json`: the official skill dependency is sufficient and smaller, and avoiding a second declaration reduces duplicate-binding risk. Do not add `.app.json`, hooks, scripts, assets, references, binaries, generated task files, a package manager manifest, or catalog content. `allow_implicit_invocation: true` permits Codex to consider the skill; it is not a guarantee that the model will select it.

The `SKILL.md` description must trigger only for non-routine specialist domains, named technology workflows, formal reviews/evaluations, safety/compliance procedures, or specialized deliverables where procedural guidance could materially help. It must exclude greetings, trivial transformations/calculations, routine generic work, repeated intent, sensitive summaries, and tasks already covered by sufficient local/loaded guidance. The body mirrors the existing one-search, one-exact-load, progressive-resource, automatic/user-requested, attribution, privacy, and fail-open policy.

### 3. MCP dependency and credential boundary

The skill dependency is metadata, not an implementation of SkillWire. Its exact fields are `type`, `value`, `description`, `transport`, and `url`. The production package must contain a literal canonical HTTPS URL with no user info, query credential, fragment, placeholder, or tenant identifier. Because the official dependency schema has no credential-value field, no key or bearer token appears in the plugin.

For bearer deployments, the user/operator configures the existing connection through Codex's supported MCP manager, for example with a protected environment-variable reference. The plugin never reads, copies, prints, or deletes that variable or stored OAuth state. Paired evaluation preconfigures the same authenticated SkillWire endpoint in both cohorts, making the adapter the only experimental difference.

Codex behavior is handled as follows:

| Condition | Adapter/manager behavior |
|-----------|--------------------------|
| Equivalent connection already configured | Reuse the canonical transport/URL match; do not create a second SkillWire binding or overwrite user configuration. Record which binding won in verification. |
| Dependency absent | Codex may offer to add it. Decline or failure leaves the plugin installed but remote activation unavailable; the skill stops and normal work continues. SkillWire code performs no installation. |
| Same logical name, different endpoint | Do not overwrite the existing registration. Report a categorical conflict and fail open for automatic activation. |
| Unavailable, incompatible, timeout, unauthenticated, or rate-limited | At most one automatic attempt, then no retry, reformulation, alternate candidate, context escalation, or startup blocking. |
| Plugin absent | Explicitly configured MCP operations remain usable; no autonomous Codex claim is made. |

### 4. Marketplace, version, integrity, and uninstall structures

Publish through one dedicated Git-backed marketplace named `skillwire`. Its `.agents/plugins/marketplace.json` contains one entry with matching plugin name, a `git-subdir` source, repository URL, `./`-prefixed plugin path, exact 40-character source commit `sha`, `installation: AVAILABLE`, `authentication: ON_USE`, and category `Developer Tools`. The checked-in `distribution/codex-marketplace/marketplace.json` is the release input for that separate catalog; it is not placed at this repository's `.agents/plugins` path.

Versioning has three identities:

- plugin semantic version (`0.1.0`, incremented for every package change);
- immutable source commit SHA in the marketplace entry;
- `skillwire-activation-v1` server-policy version and `skillwire-codex-adapter-v1` adapter-policy identifier recorded in the skill and evidence.

Release promotion is two-step to avoid a self-referential commit: commit the plugin package, compute the ordered file SHA-256 manifest, then update the separate marketplace entry to that exact plugin commit. Validate the marketplace snapshot and installed package before promotion.

The official manifest has no uninstall field or uninstall script. The uninstall structure is the manager identity `skillwire-autonomous-activation@skillwire` plus Codex-owned cache/config state. Installation uses `codex plugin add`; verification uses `codex plugin list --json` plus effective skill/MCP inventory; upgrade uses `codex plugin marketplace upgrade` and verifies the refreshed installed version (re-running `plugin add` only when required by the pinned manager); removal uses `codex plugin remove`. Marketplace removal is separate and occurs only if no other SkillWire plugin depends on it. No code edits Codex cache/config directly.

### 5. Bounded activation and enforceability

The server still enforces schemas, automatic filtering, positive relevance, exact immutable load, integrity, provenance, advisory, resource safety, auth, tenancy, rate limits, memory scope, no GitHub operation dependency, and no client-write capability. The plugin influences model selection and states per-task bounds, but it cannot cryptographically enforce task intent, local-skill equivalence, one-attempt state, explicit-intent truthfulness, or model continuation. These remain observable trace requirements.

Successful adapter attribution requires an ordered actual MCP trace:

```text
search_skills(invocationContext=automatic)
  -> relevant preview(skillId, exact revision)
  -> load_skill(exact preview identity)
  -> optional read_skill_resource(exact loaded identity, useful declared path)
```

Adapter invocation, tool availability, prose, a search preview, or a local skill name is not success. Repository usage remains attributable only to the verified load; the adapter never records memory itself.

## Evaluation and Testing Strategy

### Deterministic required CI

Reuse the 75-case corpus and all compatible tests. Validate the immutable 15-case release-candidate pilot and add gates that:

1. Preserve legacy/current instruction identity, the 512-code-point decision capsule, six tools, descriptions, annotations, and unchanged schemas.
2. Validate the exact three-file package allowlist, JSON/YAML/frontmatter schemas, names, versions, relative paths, implicit policy, dependency URL, semantic consistency with server policy, and absence of secrets, hashes, account/repository data, executable bits, hooks, scripts, remote skill content, and repository paths.
3. Validate the static marketplace entry, exact plugin/marketplace identity, Git source/path/SHA, policies, release-integrity hashes, and reject mutable or credential-bearing sources.
4. Run `marketplace add/list -> plugin list --available -> plugin add -> plugin list -> marketplace upgrade -> plugin remove -> marketplace remove` through the pinned official Codex plugin manager in disposable `HOME` and `CODEX_HOME`. Digest an unrelated temporary repository throughout. Verify one installed identity, exact version/hashes, no duplicate effective dependency, zero credential output, rollback-safe failed upgrade, and zero adapter-owned files after removal.
5. Exercise absent, equivalent existing, conflicting existing, unavailable, unauthenticated, incompatible, rate-limited, timeout, and no-result dependency paths without model calls; verify normal work is not made required on SkillWire and no automatic retry occurs in deterministic trace drivers.
6. Preserve actual registered MCP transport traces for search -> exact load -> optional resource, automatic/user-requested isolation, no-result behavior, verified-load-only memory, no GitHub request, and zero client-tree writes.
7. Run every existing Feature 001 and Feature 002 unit, contract, integration, E2E, evaluation, security, catalog, advisory, container, formatting, lint, typecheck, and build gate.

These tests validate artifacts, manager behavior, and server-controlled invariants. They do not count as spontaneous model activation and require no Codex account, model call, GitHub call, or secret.

### Paired clean-profile manual evaluation

Keep `candidate-v1.json` unchanged as the historical server-only `0/7` baseline. A new paired envelope binds its exact path/hash and contains two fresh v1-compatible runs: server instructions only and server instructions plus adapter. First-class experiment controls record the exact SkillWire commit, Codex CLI/model/reasoning, server policy, source corpus, immutable pilot ID, catalog/protocol/evaluator, clean-profile procedure, endpoint URL hash, authentication mechanism, and selected case IDs. The pair validator requires the exact 15 pilot IDs, prompt bytes, and server configuration to match; only the adapter/plugin inventory may differ. It must never relabel or mutate the historical baseline.

For a release candidate, run the immutable stratified pilot—8 clean automatic, 3 irrelevant, 2 explicit user-requested, and the corresponding 2 no-intent cases—in fresh isolated Codex sessions under:

- A: server instructions only;
- B: the identical server connection plus `skillwire-autonomous-activation@skillwire`.

Use disposable restrictive `HOME`/`CODEX_HOME`, an empty Git repository outside the SkillWire hierarchy, no repository/admin/user/plugin skills other than unavoidable Codex system skills, no extra MCP servers, and a protected ephemeral credential mechanism cleaned afterward. Record the effective skill and MCP inventories, Codex/plugin-manager version, model/reasoning, SkillWire commit, server policy, adapter version/hash, corpus/catalog versions, and actual redacted MCP traces. The prompt text comes only from the existing corpus and does not mention SkillWire, MCP, tool names, or exact skill names except explicit-intent cases.

Report clean relevant, irrelevant, user-requested, and resource-progressive strata separately. The five predeclared local-overlap cases are not part of the pilot: retain their deterministic coverage and report any optional real-harness overlap run separately against a version-recorded, pre-existing controlled local inventory that SkillWire neither installs nor modifies. Preserve incomplete/externally blocked cases outside positive denominators and surface them as claim diagnostics. Model-dependent evidence remains outside required CI. The pilot target is at least 80% spontaneous automatic search over the 8 selected relevant prompts, >=90% exact selection after search, <=10% irrelevant activation over the 3 selected irrelevant prompts, 100% isolation over the 2 selected user-requested pairs, and zero client-tree writes. Every counted success must include exact ordered search/load evidence. Passing supports only a qualified pilot observation for the recorded configuration, never a statistically definitive or universal autonomous-activation claim. The 30-case 15/5/5/5 pair is an optional, separately identified, non-blocking extended benchmark; the full 65-case non-overlap pair is optional expanded evidence.

## Security, Privacy, and Observability

- Static validation scans the plugin, marketplace, release manifest, manager stdout/stderr, and paired evidence for API keys, bearer values, authorization headers, repository hashes, account data, generated credentials, raw prompts, paths, and skill contents.
- Lifecycle commands run only in disposable profiles. Tests observe Codex-managed state but SkillWire code never writes, deletes, or chmods it.
- The plugin has no telemetry. Existing server logs remain categorical and do not add prompts/task summaries to measure activation.
- Manual evidence uses corpus case IDs and public frozen identities. Server-side observer traces redact task strings, headers, tokens, repository hashes, and response bodies.
- A package hash or Git commit is public release integrity metadata, never a repository-memory fingerprint.
- Local skill use is distinguished from SkillWire only by an actual provenance-bearing exact load; the plugin name or skill invocation is not attribution.

## Failure-Mode Analysis

| Failure | Required result |
|---------|-----------------|
| Marketplace unavailable or entry unresolved | Manager reports a categorical lifecycle failure; existing installed version remains verifiable; normal Codex work and explicit MCP use continue. |
| Package identity/version/hash invalid | Installation/upgrade fails before acceptance; no partial second identity and no repository write. |
| Upgrade interrupted | Codex's staged activation/rollback behavior is verified; publish last-known-good contents as a higher version for rollback rather than editing cache. |
| Plugin unavailable/disabled/uninstalled | Reverts to server-only advisory behavior; preserved baseline remains applicable; explicit MCP operation stays available if independently configured. |
| MCP dependency missing/conflicting | Do not overwrite user configuration or loop on installation prompts; skip automatic SkillWire usage and continue. |
| MCP auth/network/protocol/rate/timeout failure | Stop after the first attempted automatic operation, record only safe diagnostics, write no memory, and continue normally. |
| Search empty | Return `skills: []`; no load, retry, broadened query, or user-requested escalation. |
| Exact load/resource failure | No alternate revision/candidate; no false attribution. A prior verified-load usage row is not undone by later resource failure. |
| Equivalent/selected local skill | Local guidance remains authoritative; no duplicate remote load or silent override; report overlap separately. |
| Harness ignores implicit skill | Record non-activation honestly; do not infer from prose and do not weaken thresholds. |

## Rollout, Backward Compatibility, and Rollback

1. Keep and re-run all compatible server implementation/tests; do not reopen Features 001 or 002.
2. Land package/marketplace contracts and failing deterministic validators before adding the three plugin artifacts.
3. Validate package and full disposable manager lifecycle offline, including current server regressions.
4. Publish plugin source commit, hashes, and then the exact-SHA marketplace entry. Installation is opt-in (`AVAILABLE`, `ON_USE`).
5. Run the frozen 15-case paired clean-profile pilot. Preserve `candidate-v1.json` byte-for-byte and with its recorded SHA-256; treat the 30-case pair as an optional extended benchmark and the 65-case pair as optional expanded evidence.
6. Claim autonomous Codex activation only after adapter evidence meets the acceptance target; otherwise keep the plugin experimental and report the measured limitation.

Server clients see no operation or schema change. Users without the plugin keep the same explicit SkillWire workflow and advisory instructions. Removing the plugin through Codex restores server-only behavior without changing server, database, repository memory, external credentials, or repositories. Emergency rollback is manager uninstall; normal rollback republishes last-known-good content under a higher semantic version and promotes its exact commit through the marketplace.

## Post-design Constitution Re-check

Phase 1 remains compliant. The adapter is optional, separately packaged, content-free, retrieval-guiding, user-scoped, and manager-owned. It does not install catalog skills, become part of the protocol core, weaken provenance/privacy/security, or introduce a marketplace service. The plan adds deterministic lifecycle and boundary evidence while preserving all existing contracts and the immutable negative baseline.

## Complexity Tracking

No constitution violation requires an exception. The static plugin package and static marketplace catalog are the minimum harness integration justified by the falsified server-only Codex hypothesis.
