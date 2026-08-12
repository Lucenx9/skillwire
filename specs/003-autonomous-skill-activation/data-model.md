# Data Model: Autonomous Skill Activation

Feature 003 adds versioned policy, a static Codex adapter package, marketplace release metadata, and paired evaluation records, not production persistence. Existing catalog, provenance, advisory, resource, account, and repository-memory models remain authoritative and require no migration.

## 1. Activation Policy

An immutable compile-time value published through MCP server instructions.

| Field | Type | Constraints |
|-------|------|-------------|
| `version` | string | Stable non-secret identifier; `skillwire-activation-v1`; changes whenever normative server instruction meaning changes. |
| `decisionCapsule` | string | At most 512 Unicode code points; self-contained advisory tool-selection guidance. |
| `instructions` | string | Capsule plus workflow guidance; at most 1,200 Unicode code points. |
| `toolMetadata` | map keyed by existing tool name | Exactly six entries; each has one description and standard MCP annotations. |

Invariants:

- The full instructions begin with the exact decision capsule.
- Instructions contain no tenant/catalog dynamic data, client name, launcher/UI behavior, local path, credential, URL, or private task content.
- The same value is exposed by legacy initialize and modern discovery.
- The policy is advisory. It creates no session, task, or local-inventory state and does not guarantee harness invocation.

## 2. Codex Activation Plugin

A static package installed only by the Codex plugin manager at user scope.

| Field | Type | Constraints |
|-------|------|-------------|
| `pluginName` | string | Exactly `skillwire-autonomous-activation`; stable manager identity. |
| `pluginVersion` | semver | Starts at `0.1.0`; changes for every package-content change. |
| `adapterPolicyVersion` | string | `skillwire-codex-adapter-v1`; recorded in guidance/evidence, never used as a credential. |
| `skillsPath` | relative path | Exactly `./skills/`; remains inside the plugin root. |
| `fileInventory` | ordered set | Exactly `.codex-plugin/plugin.json`, one `SKILL.md`, and one `agents/openai.yaml`. |
| `fileSha256` | map | SHA-256 for each ordered file in external release-integrity metadata. |

Invariants:

- No `.mcp.json`, `.app.json`, hook, script, executable, asset, reference, package-manager file, catalog entry, remote instruction/resource, credential, repository identifier, or generated task file.
- The plugin is optional. Removing it cannot remove or change an independently configured SkillWire connection.
- SkillWire runtime code never writes, upgrades, or removes the installed copy; Codex owns its cache and configuration.

## 3. Activation Skill

The only bundled skill is activation guidance, not a remotely delivered catalog skill.

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string | Exactly `autonomous-skill-activation`; unique in the plugin. |
| `description` | string | Front-loaded specialized-task triggers and material non-triggers; no generic “always use” wording. |
| `instructions` | Markdown | Bounded search/load/resource/fail-open workflow; no remote skill content. |
| `products` | enum set | Exactly `[CODEX]` for the first adapter. |
| `allowImplicitInvocation` | boolean | Explicitly `true`; permits consideration but does not guarantee selection. |

The namespaced identity `skillwire-autonomous-activation:autonomous-skill-activation` must remain within the current Codex validator bound. Local, repository, admin, system, and plugin skills remain distinct inventory sources. The activation skill is attributable to its plugin; a remote SkillWire skill is attributable only to a verified exact MCP load.

## 4. Skill-Level MCP Dependency

The `agents/openai.yaml` declaration identifying the unchanged SkillWire service.

| Field | Type | Constraints |
|-------|------|-------------|
| `type` | literal | `mcp`. |
| `value` | string | Exactly `skillwire`; stable logical identity. |
| `description` | string | Concise capability statement, no instructions or secret. |
| `transport` | literal | `streamable_http`. |
| `url` | HTTPS URL | Canonical release endpoint; no user info, query, fragment, placeholder, tenant, or credential. |

Dependency state observed by lifecycle/evaluation is categorical: `equivalent-existing`, `manager-added`, `absent`, `name-conflict`, `unavailable`, `unauthenticated`, `incompatible`, `rate-limited`, or `timed-out`. The plugin does not store this state. Credentials and protected environment-variable references belong to external Codex MCP configuration, not package fields.

## 5. Marketplace Entry and Release Integrity

| Field | Type | Constraints |
|-------|------|-------------|
| marketplace `name` | string | Exactly `skillwire`. |
| plugin `name` | string | Equals the manifest plugin name. |
| `source.source` | literal | `git-subdir`. |
| `source.url` | HTTPS Git URL | Credential-free SkillWire-controlled source. |
| `source.path` | relative path | `./`-prefixed, inside source repository, points to plugin root. |
| `source.sha` | Git object ID | Exact lowercase 40-character commit SHA for plugin contents. |
| `policy.installation` | literal | `AVAILABLE`. |
| `policy.authentication` | literal | `ON_USE`. |
| `category` | literal | `Developer Tools`. |
| integrity manifest | JSON record | Plugin/adapter versions, source SHA, ordered file paths/hashes, validator version; no secret. |

The marketplace publication commit is separate from the referenced plugin source commit. The marketplace catalog is static distribution metadata, not production storage or a marketplace service.

## 6. Activation Attempt

A conceptual harness-side state used by evaluation; it is not stored or received by SkillWire.

| Field | Type | Meaning |
|-------|------|---------|
| `taskIntent` | opaque harness concept | The unchanged current objective; never persisted as a SkillWire identifier. |
| `explicitUserIntent` | boolean | Whether the active user explicitly requested the relevant skill/context. |
| `localSkillState` | `none \| overlapping \| equivalent \| explicitly-selected` | Harness-observed local guidance condition. |
| `searchCount` | integer 0-1 | Advisory automatic-call budget. |
| `loadCount` | integer 0-1 | Advisory exact-load budget. |
| `resourcePathsRead` | unique string set | Declared paths read because each was specifically useful. |
| `terminalReason` | enum | `not-applicable`, `local-precedence`, `no-result`, `loaded`, `completed`, or safe failure category. |

```text
not-evaluated
  ├─ non-trigger/local guidance ───────────────> stopped
  └─ specialized, no local guidance ─> searched
       ├─ empty/error ─────────────────────────> stopped
       └─ relevant preview ──────────────> exact-loaded
            ├─ main instructions sufficient ──> completed
            ├─ useful declared resource ───────> resource-read ─> completed
            └─ load/resource error ────────────> stopped
```

No failure transition loops back to search or chooses another candidate. A materially new user objective creates a new conceptual attempt.

## 7. Invocation Context

| Value | Meaning | Enforcement |
|-------|---------|-------------|
| `automatic` | Agent discovery without explicit user-only opt-in; existing default when omitted. | Server removes `user-only` entries before ranking. |
| `user-requested` | Active user explicitly requested the relevant skill or context. | Server includes eligible entries but cannot prove the conversational assertion. |

The task summary remains bounded, non-sensitive caller input. It is not a source of truth for explicit intent and is never persisted in repository memory.

## 8. Relevant Search Match

| Field | Type | Constraints |
|-------|------|-------------|
| `skillId` | string | Existing public catalog identity. |
| `revision` | string | Exact immutable revision in preview. |
| `taskRelevanceScore` | integer | At least `MINIMUM_RELEVANCE_SCORE = 1`. |
| `memoryBoost` | bounded integer | Tie influence only after relevance; cannot expose zero-score skills. |
| `stableTieBreaker` | string | Existing skill identity ordering. |

Revoked and invocation-ineligible entries are removed before ranking. Scores below 1 are removed before limiting. No unrelated fallback exists.

## 9. Verified SkillWire Load

The only event that attributes delivered remote guidance to SkillWire.

| Field | Source | Verification |
|-------|--------|--------------|
| `skillId` | selected preview/provider | Exact equality; no local-name inference. |
| `revision` | selected preview/provider | Exact equality; no floating/latest substitution. |
| `revisionSha256` | verified revision | Existing canonical integrity rules. |
| `publishedProvenance` | verified revision | Existing immutable publication evidence. |
| `currentAdvisoryStatus` | advisory service/provider | Must not be revoked. |
| `instructions` | verified revision | Bounded inert Markdown/text data. |
| `resourceManifest` | verified revision | Complete declared resource identities, sizes, and hashes. |

An adapter invocation, attempted load, search preview, final answer, or local skill with the same name is not a verified SkillWire load.

## 10. Repository Usage Attribution

Existing PostgreSQL-backed entity, unchanged:

| Key/data | Constraint |
|----------|------------|
| authenticated `accountId` | Taken only from request principal. |
| `repositoryHash` | Existing 64-character lowercase hexadecimal opaque fingerprint. |
| `skillId`, `revision`, `revisionSha256` | Taken from the verified exact load, never from adapter/search/local inventory. |
| usage count/timestamps/outcome | Existing store behavior and tenant/account predicates. |

- No repository hash: load succeeds without memory.
- Hash plus verified exact load: record/increment usage.
- Failed/unavailable/revoked/malformed/pre-commit-cancelled load: no usage row.
- Search, adapter invocation, local-skill use, or resource read: no usage row.
- Outcome update: only an existing exact usage row; positive additionally needs completed-task evidence or explicit feedback as advisory evidence.

## 11. Frozen Activation Case

The existing version-controlled synthetic record validated by `contracts/activation-corpus.schema.json` remains unchanged. It carries a stable case ID, synthetic prompt, scenario/intent/local condition, expected immutable catalog match or no-match, expected call bounds/resources/failure behavior, and rationale. Semantic validation preserves the 75-case composition, pair completeness, catalog identities, local-overlap declarations, and privacy safety.

## 12. Manual Evaluation Run and Observation

The v1 evidence object remains valid under `contracts/manual-evidence.schema.json` and contains no production task data.

Run metadata records policy/corpus/catalog/protocol, harness/model/reasoning, environment/local inventory, evaluator, and instruction integrity. Per-case observations contain only case ID, ordered operation names and public frozen identities, invocation context, safe error category, completion evidence, zero-write/GitHub counters, and diagnostic codes. Metrics are recomputed: spontaneous search, post-search exact selection, irrelevant activation, user-requested isolation, progressive loading, local overlap, and zero writes.

## 13. Paired Adapter Evidence

A non-blocking release envelope defined by `contracts/paired-adapter-evidence.schema.json`.

| Field | Constraint |
|-------|------------|
| `preservedBaseline.path` | `evaluation/evidence/003/candidate-v1.json`. |
| `preservedBaseline.sha256` | `04cd236d6ddd27f30c21f7d332577ef3a91a3f55fc6ab79d1fd1f02d4900db2d`. |
| `preservedBaseline.condition` | `historical-server-only`; preserves `0/7` completed spontaneous activations. |
| `experiment` | Exact SkillWire commit, Codex CLI/model/reasoning, server policy, corpus/catalog/protocol/evaluator, clean-profile procedure, endpoint URL hash, authentication mechanism, selected case IDs, and categorized effective inventories shared or contrasted by the pair. |
| `adapter` | Exact plugin/marketplace identity, versions, source commit, dependency state, and package integrity hash. |
| `serverOnlyRun` | Fresh complete v1-compatible evidence object for server instructions only. |
| `adapterRun` | Complete v1-compatible manual evidence object for server plus adapter. |
| `claimEligibility` | Derived by validator; true only when all targets and attributable trace rules pass. |

The validator requires the two fresh runs to use the same selected frozen case IDs and prompt bytes, catalog, server commit/configuration, endpoint/auth mechanism, Codex/model/reasoning versions, protocol, evaluator, and clean-profile procedure. Only the adapter/plugin inventory may differ. A later full paired 75-case rerun is a new artifact. It cannot replace, mutate, relabel, or reinterpret the historical baseline.

## Persistence Impact

None. Activation policy is compiled server metadata. Plugin/marketplace packages are static release artifacts managed on the client only by Codex. Corpora and evidence are version-controlled JSON artifacts or external release evidence. Existing database tables, indexes, migrations, retention, erasure, and tenant scoping are unchanged.
