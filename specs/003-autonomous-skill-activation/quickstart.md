# Quickstart: Validate Autonomous Skill Activation

This guide separates deterministic server/plugin gates from model-dependent evidence. The server contract is [mcp-activation.md](./contracts/mcp-activation.md); the adapter package and manager lifecycle are [codex-activation-plugin.md](./contracts/codex-activation-plugin.md).

## Prerequisites

- Node.js 24 or newer and pnpm 11.21.0
- Docker for existing PostgreSQL integration projects
- Feature branch `003-autonomous-skill-activation`
- Codex CLI/plugin manager version pinned by the lockfile for lifecycle tests
- No Codex account, model, SkillWire, GitHub, or other live-service credential for required CI

```bash
pnpm install --frozen-lockfile
```

## 1. Preserve the server-only baseline

Before and after every Feature 003 change:

```bash
sha256sum evaluation/evidence/003/candidate-v1.json
```

Expected SHA-256:

```text
04cd236d6ddd27f30c21f7d332577ef3a91a3f55fc6ab79d1fd1f02d4900db2d
```

The artifact records `0/7` spontaneous activations for Codex CLI `0.147.0`, `gpt-5.6-sol`, and `xhigh` despite correctly delivered server instructions and metadata. Do not overwrite, relabel, or count it as adapter evidence.

## 2. Validate the portable server policy

```bash
pnpm exec vitest run --project contract tests/contract/mcp/activation-metadata.test.ts
```

Expected:

- legacy initialize and modern `server/discover` expose the same centralized text;
- the decision capsule is at most 512 Unicode code points and the full text at most 1,200;
- `tools/list` returns exactly the existing six tools, unchanged schemas, and contracted descriptions/annotations;
- metadata states the one-attempt, invocation-context, privacy, inert-content, and fail-open boundaries without claiming guaranteed invocation.

## 3. Validate the frozen 75-case corpus and server behavior

```bash
pnpm exec vitest run --project unit \
  tests/unit/evaluation/activation-corpus.test.ts \
  tests/unit/domain/ranking.test.ts

pnpm exec vitest run --project evaluation \
  tests/evaluation/autonomous-activation.test.ts
```

Expected:

- `evaluation/autonomous-activation.v1.json` and its existing schema remain unchanged;
- all IDs/pairs, category minima, immutable catalog matches, resource expectations, and local-overlap declarations pass;
- automatic context excludes user-only skills, explicit context preserves eligible opt-in matches, score zero returns no result, and relevance precedes memory.

## 4. Validate the exact Codex adapter package

```bash
pnpm exec vitest run --project unit \
  tests/unit/evaluation/codex-adapter-package.test.ts
```

The validator must find only:

```text
.codex-plugin/plugin.json
skills/autonomous-skill-activation/SKILL.md
skills/autonomous-skill-activation/agents/openai.yaml
```

It checks the exact plugin/skill names, semantic version, `./skills/` path, Codex-only implicit policy, single credential-free `skillwire` Streamable HTTP dependency, canonical HTTPS endpoint, semantic consistency with the server policy, and release hashes. It rejects extra files, executable bits, links, `.mcp.json`, `.app.json`, hooks, scripts, assets, catalog content, remote skill instructions/resources, repository paths/hashes, account data, API keys, bearer values, authorization headers, or generated credentials.

## 5. Validate the marketplace and Codex-managed lifecycle offline

The deterministic CLI contract creates restrictive disposable `HOME` and `CODEX_HOME` directories plus an unrelated empty temporary Git repository. It points the manager to a local fixture of the release catalog and never uses the normal profile.

```bash
pnpm exec vitest run --project contract \
  tests/contract/cli/codex-activation-plugin.test.ts
```

The test drives the supported lifecycle:

```text
codex plugin marketplace add <fixture-root>
codex plugin marketplace list --json
codex plugin list --marketplace skillwire --available --json
codex plugin add skillwire-autonomous-activation@skillwire --json
codex plugin list --marketplace skillwire --json
codex plugin marketplace upgrade skillwire --json
codex plugin remove skillwire-autonomous-activation@skillwire --json
codex plugin marketplace remove skillwire --json
```

Expected:

- one installed/enabled plugin identity and exact version while installed;
- the manager-owned installed copy matches the release hashes;
- an equivalent existing SkillWire endpoint is reused, while a same-name/different-endpoint conflict is not overwritten;
- unavailable, unauthenticated, incompatible, rate-limited, timeout, absent, and failed-upgrade fixtures degrade safely;
- no secret appears in command arguments, JSON output, logs, package, or marketplace;
- the temporary repository digest never changes;
- removal leaves no adapter-owned plugin files while external MCP credentials/configuration remain untouched.

There is no custom installer, `plugin verify`, `plugin upgrade`, or uninstall script. Verification is manager JSON plus effective inventory and hashes; upgrade is marketplace refresh; uninstall is `plugin remove`.

## 6. Prove actual MCP operation paths

```bash
pnpm exec vitest run --project e2e \
  tests/e2e/autonomous-activation-transport.test.ts \
  tests/e2e/no-client-write.test.ts
```

Expected real registered transport traces include:

```text
instructions -> search_skills(automatic) -> load_skill(exact revision)
instructions -> search_skills(automatic) -> load_skill(exact revision) -> read_skill_resource(declared path)
```

Assertions cover exact preview/load identity, hash, provenance, advisory, resource integrity, maximum one search/load, no duplicate path, memory only after verified load, no load after empty search, user-requested isolation, safe failures without retry, zero GitHub requests, and unchanged client trees. This scripted sequence proves the protocol path, not spontaneous model choice.

## 7. Run all deterministic release gates

```bash
pnpm test:activation
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:e2e
pnpm test:evaluation
pnpm test:security
```

Also run the existing build, catalog integrity, advisory integrity, PostgreSQL, container-boundary, formatting, and `git diff --check` commands used by CI. All Feature 001 and Feature 002 tests must pass. Required CI makes no model call, contacts no live GitHub/SkillWire service, and needs no credential.

## 8. Configure, install, verify, upgrade, and remove a release adapter

These operator commands are outside required CI and must use Codex's manager. SkillWire application code must never reproduce their writes.

```text
codex plugin marketplace add <skillwire-marketplace-git-url> --ref <release-channel>
codex plugin marketplace list --json
codex plugin list --marketplace skillwire --available --json
codex plugin add skillwire-autonomous-activation@skillwire --json
codex plugin list --marketplace skillwire --json
codex mcp list
```

Start a new Codex session after install. If the SkillWire connection is not already configured, Codex may offer its supported dependency setup. Never place a credential in the plugin or marketplace. For bearer deployments, configure the endpoint separately using Codex's protected environment-variable reference; for OAuth deployments use Codex's login flow.

Upgrade and verify the reported plugin version/source:

```text
codex plugin marketplace upgrade skillwire --json
codex plugin list --marketplace skillwire --json
```

Remove only the adapter:

```text
codex plugin remove skillwire-autonomous-activation@skillwire --json
```

Remove the marketplace only if no other SkillWire entry uses it:

```text
codex plugin marketplace remove skillwire --json
```

An unavailable/unauthenticated/conflicting dependency leaves the plugin installed but automatic remote guidance unavailable. It must not block ordinary work, retry, or overwrite user configuration. Explicit MCP operation remains possible through an independent connection after plugin removal.

## 9. Run paired clean-profile model evaluation

This step is non-blocking and outside required CI. Use restrictive disposable profiles and an empty Git repository outside the SkillWire hierarchy. Load no normal user configuration, plugins, extra MCP servers, user/repository/admin skills, `AGENTS.md`, `.agents/skills`, or `.codex` repository files. Unavoidable Codex system skills are platform baseline.

For every applicable non-overlap frozen case, run fresh otherwise identical sessions under:

1. server instructions only;
2. server instructions plus `skillwire-autonomous-activation@skillwire`.

Preconfigure exactly the same authenticated SkillWire MCP endpoint in both cohorts through a protected ephemeral mechanism. Record effective skill/plugin/MCP inventories, Codex/model/reasoning, SkillWire commit, server and adapter policies, corpus/catalog, plugin source/hash, dependency state, and ordered privacy-safe MCP traces. Prompts come verbatim from the frozen corpus and do not mention SkillWire, MCP, tool names, the adapter, or exact skill names except explicit-intent cases.

Count activation only when observer/server evidence proves:

```text
search_skills -> load_skill(the exact previewed revision) -> optional fixture-required read_skill_resource
```

Adapter invocation or final prose alone is not evidence. The five predeclared local-overlap cases stay outside this clean-profile claim cohort. Their deterministic coverage remains required; any optional real-harness overlap run uses a separately version-recorded, pre-existing controlled local inventory that SkillWire does not install or modify and is reported separately. Clean both disposable profiles, credentials, repositories, and generated secrets after validation.

Validate the run and paired envelope offline:

```text
pnpm exec tsx scripts/activation-evidence.ts validate --input <adapter-run.json>
pnpm exec tsx scripts/activation-evidence.ts validate-pair --input <paired-evidence.json>
```

The paired envelope must bind the immutable historical baseline path and SHA-256 and embed both fresh runs through `paired-adapter-evidence.schema.json`. Validation rejects different case sets, prompt bytes, catalog, server commit/configuration, endpoint/auth mechanism, Codex/model/reasoning versions, protocol, evaluator, or clean-profile procedure. Only the adapter/plugin inventory may differ. Neither fresh run replaces `candidate-v1.json`.

## 10. Interpret results honestly

| Adapter cohort metric | Claim threshold |
|-----------------------|-----------------|
| Spontaneous automatic search on at least 25 relevant clean prompts | >=80% |
| Correct exact load after search | >=90% |
| Any SkillWire operation on at least 15 irrelevant prompts | <=10% |
| User-requested isolation | 100% |
| Client-tree writes | zero |

Incomplete/external failures are reported separately and never counted positive. Server-only results are descriptive baselines. Model-dependent evidence remains non-blocking, but SkillWire must not claim autonomous Codex activation unless the adapter cohort meets all claim thresholds with attributable traces.
