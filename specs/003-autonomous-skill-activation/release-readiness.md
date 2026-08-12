# Feature 003 Release Readiness

**Branch**: `003-autonomous-skill-activation`
**Recorded**: 2026-08-12
**Status**: deterministic gates pass; paired pilot and overlap evidence are complete; the Codex adapter remains experimental and the autonomous-activation claim remains gated

## Release-candidate evaluation protocol amendments

Before any adapter-cohort outcome was observed, the original 65-cases-per-condition live protocol was stopped solely because its measured runtime was too expensive for a Feature 003 release gate. The active server-only case was allowed to finish and no later case started. The stopped 65-case attempt is not release evidence and was not used to select cases.

The first runtime amendment defined an outcome-independent 30-case 15/5/5/5 replacement in corpus-stratum order. It retained Codex CLI `0.147.0`, `gpt-5.6-sol`, `xhigh`, a 180-second single-attempt timeout, the same frozen-catalog SkillWire revision, protected ephemeral authentication, redacted observer, privacy boundary, and zero-write check. That protocol began running but was not promoted to release evidence.

That 30-case protocol was subsequently stopped after its active adapter case completed because its runtime was still too expensive. No later case started. The operator then supplied a second outcome-independent selection rule: first 8 clean automatic cases by immutable corpus order, first 3 irrelevant cases, first 2 explicit cases, and their corresponding first 2 no-intent pairs. It explicitly forbids taking the first 15 sequential corpus cases. The resulting exact 15 IDs are frozen in `evaluation/autonomous-activation-release-subset.v1.json` and both conditions use that order.

The 15-case selection rule was supplied independently of outcomes. By the time this amendment was applied, the earlier 30-case run had already recorded 30 server-only observations and 10 adapter observations, plus one stopped adapter case with no completed observation record. Matching observations are reusable only when their IDs belong to the new pilot and all pinned controls match. Nonmatching completed observations and the stopped-case trace remain disclosed as out-of-cohort evidence; they are not discarded, selected into the pilot, retried, or used in pilot metrics.

The pilot retains Codex CLI `0.147.0`, `gpt-5.6-sol`, `xhigh`, the 180-second single-attempt timeout, frozen-catalog SkillWire revision, protected ephemeral authentication, redacted observer, fresh-session isolation, privacy boundary, and zero-write checks. Its result is pilot/release-candidate evidence only for the recorded configuration. It is not a statistically definitive or universal claim about other prompts, clients, models, reasoning settings, or harness versions. The 30-case 15/5/5/5 pair is now an optional non-blocking extended benchmark; the original 65-case non-overlap pair is an optional expanded benchmark. Each needs a separate evidence identity and neither can replace or be merged into the pilot. The historical `candidate-v1.json` remains byte-for-byte unchanged and is neither replaced nor reinterpreted.

The formatted immutable pilot subset SHA-256 is `d88eb75cef1a426d05094b49bf0a64700ff0a7eebb023747349dd48dd4cd4b74`. The source corpus remains `a06e1ced82026bf007e0f1d9ee53c0a57c526cf59784285098a2840cb13e8b28`, the preserved historical candidate remains `04cd236d6ddd27f30c21f7d332577ef3a91a3f55fc6ab79d1fd1f02d4900db2d`, and the separately observed local-overlap evidence remains `213e2ea57c4f8e5f1d836567ebddffe100ad5ec72a3dd4e59dfe6a3abba410e8`.

## Deterministic gates

| Gate | Result |
|------|--------|
| Prettier full configured surface | Pass |
| Type-aware ESLint | Pass |
| Strict TypeScript typecheck | Pass |
| Production TypeScript build | Pass |
| `test:activation` | Pass: 13 files, 94 tests |
| `test:activation-adapter` | Pass: 6 files, 60 tests, including real Codex-manager lifecycle against the pinned commit |
| Complete Node 24/PostgreSQL/container Vitest matrix | Pass: 85 files and 415 tests; 1 file / 2 tests skipped by design in the container (credential-gated live GitHub and the `.git`-absent checkout case, which passed separately against the real repository) |
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
- The complete suite ran once inside the Node `24.18.0` test image against the
  disposable PostgreSQL service: 85 files and 415 tests passed.

## Compatibility and scope audit

- MCP operation count remains exactly six; no names, titles, input schemas, output schemas, handlers, or error envelopes were added or removed.
- No database migration was added; migrations remain `001` through `008`.
- No repository-scoped client file, remote skill installation, UI integration,
  launcher, dashboard, semantic embedding, source-curation behavior, or GitHub
  discovery path was added.
- No file under `specs/001-remote-skill-delivery/` or `specs/002-github-catalog-ingestion/` changed.
- Agent-facing MCP composition still has no GitHub client and no client-path/write capability.
- The optional adapter source contains exactly the three contracted package
  files. No root `.codex` or `.agents` activation/configuration file was added,
  and application-core modules contain no Codex-directory write path.
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

Task T046 is complete as a falsifying historical measurement, not as an
activation success. The measured result is that this pinned Codex harness/model
received the required decision surface but made no spontaneous calls. No
server-side contract defect, client contamination, fabricated call, or
successful activation claim was found. This result remains non-blocking for
deterministic CI.

## Paired pilot evidence

The privacy-safe paired artifact is
`evaluation/evidence/003/adapter-pair-v1.json`. It binds the immutable historical
candidate and the exact 15-case subset at SHA-256
`d88eb75cef1a426d05094b49bf0a64700ff0a7eebb023747349dd48dd4cd4b74`.
Both conditions used Codex CLI `0.147.0`, `gpt-5.6-sol`, `xhigh`, MCP
`2026-07-28`, the same frozen SkillWire server revision and endpoint, protected
ephemeral bearer authentication, observer, fresh sessions, 180-second timeout,
one attempt, and clean categorized inventories. The adapter condition differed
only by the one manager-installed plugin skill.

| Pilot metric | Server only | Server plus adapter |
|---|---:|---:|
| Completed automatic activation | `0/7` | `7/7` |
| Correct exact selection after search | `0/0` | `9/9` |
| Irrelevant activation | `0/3` | `0/3` |
| User-requested isolation | `2/2` | `2/2` |
| Progressive-loading conformance | `0/0` | `3/9` |
| Client-tree writes | `0` | `0` |
| Agent-facing GitHub requests | `0` | `0` |

One selected automatic case in each condition timed out and remains
`incomplete`. In the adapter condition, its observer trace reached attributable
automatic search and exact load before the 180-second timeout, but it is not
counted positive. All seven completed adapter automatic cases have attributable
`search_skills(automatic)` -> exact `load_skill` evidence. Both explicit cases
have attributable `search_skills(user-requested)` -> exact opt-in `load_skill`
evidence. One no-intent case made one unnecessary automatic search but did not
load the user-only skill. The other no-intent case and all three irrelevant
cases made no SkillWire call.

Six of nine exact loads made unnecessary resource reads, including one explicit
case. The artifact preserves those calls and does not reinterpret them as
progressive loading. The validator reports
`claimEligibility.eligible=false`, `evaluatedRelevantCases=7`, and diagnostics
`insufficient-relevant-cases`, `progressive-loading-conformance-failed`,
`incomplete-observations`, and `unattributable-success-trace`. The observed
`7/7` completed automatic rate is therefore not an autonomous-activation claim.
The adapter remains experimental, and the result is pilot/release-candidate
evidence only for the pinned configuration.

Out-of-cohort observations are excluded from pilot metrics. Before the final
subset was frozen, the server-only runtime-cost run completed 15 additional
selected observations with zero repository writes. The adapter runtime-cost run
completed `auto-github-actions-ci-3` and `auto-node-api-design-1`; the observer
also recorded an exact activation chain for `auto-node-api-design-2`, but the
runner stopped before appending a completed observation, so that trace remains
incomplete. None was selected, retried, promoted into the pilot, or used to
derive claim eligibility.

## Local-overlap evidence

`evaluation/evidence/003/local-overlap-v1.json` records the five predeclared
overlap cases separately under server-only and server-plus-adapter conditions.
All ten observations completed. Each condition had three equivalent and two
overlapping local relationships, zero SkillWire operations, zero verified
remote loads, zero silent remote overrides, zero client-tree writes, and zero
controlled local-inventory writes. The plugin did not force duplicate remote
loading or cause local use to be attributed to SkillWire. These results are
outside the clean pilot denominator.

After the paired run, the official Codex manager removed
`skillwire-autonomous-activation@skillwire`; manager inventory showed the plugin
absent. A new server-only session then explicitly called
`search_skills(user-requested)` and loaded the exact
`dependency-upgrade-planning@1.0.0` revision through the independent SkillWire
connection. The marketplace was removed only after that check. Both evaluation
profiles, empty repositories, observer state, temporary credential copies, and
generated secrets were deleted.

## Immutable adapter release provenance

The model-dependent pair and overlap artifacts retain source commit
`bd7de55fefc602a7ad8fdaf1683f6dbb9eab07f9`, because that is the revision
actually observed. Their plugin package SHA-256 is
`7939fa2ca5db807365a9f54c90534538291c09bbfae56762e72f372447998830`.
The final release-source commit is
`8c7c297a95cff42eb13212fc7b5c4ede11c35c7d`; its three plugin files are
byte-identical to the observed package. Rewriting the earlier observation
provenance would be inaccurate, so the artifacts remain unchanged in meaning.

T076–T078 used two real detached checkouts of the final source commit. The
generated manifests were byte-identical and matched the checked-in integrity
metadata. The official Codex `0.147.0` manager then passed marketplace add/list,
plugin install, installed hash verification, dependency-state checks, invalid
upgrade rollback, valid upgrade, plugin uninstall, marketplace removal, and
post-removal inventory checks in restrictive disposable profiles. No repository
file, remote skill content, or credential value was written or disclosed.

Final release hashes:

| Artifact | SHA-256 |
|---|---|
| Frozen 75-case corpus | `a06e1ced82026bf007e0f1d9ee53c0a57c526cf59784285098a2840cb13e8b28` |
| Frozen 15-case pilot subset | `d88eb75cef1a426d05094b49bf0a64700ff0a7eebb023747349dd48dd4cd4b74` |
| Historical `candidate-v1.json` | `04cd236d6ddd27f30c21f7d332577ef3a91a3f55fc6ab79d1fd1f02d4900db2d` |
| Paired pilot evidence | `0e7c1aec0339292b17c81ad9f725ffc22932bfa5030b5715a7f7fc1750aa28e6` |
| Local-overlap evidence | `213e2ea57c4f8e5f1d836567ebddffe100ad5ec72a3dd4e59dfe6a3abba410e8` |
| Plugin manifest | `4d70b17a7a09c98d26aff351e372f2c0a503a6a06922b002e82bf46f091fbf39` |
| Activation `SKILL.md` | `1c4ba275a53e0695350f2aceb9424156bc9769ee315b7a3639f672309af884ba` |
| Codex skill metadata | `77ea5aa5d36b1a1e9943ffb5470bddcd5fcb64c578c70c64997b44c38fcdbb06` |
| Aggregate three-file package | `7939fa2ca5db807365a9f54c90534538291c09bbfae56762e72f372447998830` |
| Release integrity metadata | `5c317829ccb5587030c47e5146d7c28fe14dab110df8f77b3683dc34cf0ca054` |
| Marketplace metadata | `37e9a31d7964b27dd4b9403a89a110162b70bc3597dd8a2043150f8e57bac602` |

Both marketplace and integrity metadata resolve the exact source commit
`8c7c297a95cff42eb13212fc7b5c4ede11c35c7d`. No placeholder, moving branch,
unsupported activation claim, or frozen-byte drift remains.
