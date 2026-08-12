# Autonomous Activation Evaluation

Feature 003 publishes advisory MCP server instructions and an optional Codex
activation plugin. Neither surface guarantees model selection. This protocol
measures actual harness behavior separately from deterministic server CI;
graphical interfaces, launchers, and harness configuration are outside the
SkillWire system boundary.

The historical server-only baseline is immutable at
`evaluation/evidence/003/candidate-v1.json`, SHA-256
`04cd236d6ddd27f30c21f7d332577ef3a91a3f55fc6ab79d1fd1f02d4900db2d`. It records
zero attributable activations in seven completed relevant cases and must never
be replaced by the fresh paired experiment.

## Required setup

Record the exact SkillWire commit and image, policy, frozen corpus, immutable
release-subset ID and hash, catalog, local-inventory, MCP protocol, Codex CLI,
model, reasoning setting, evaluator, clean-profile procedure, endpoint-URL hash,
authentication mechanism, adapter source commit, package hash, and marketplace
identity. Use the same values in both fresh conditions. The sole experimental
difference is the installed adapter plugin and its one categorized plugin skill.

Create separate mode-`0700` disposable `HOME` and `CODEX_HOME` directories for
each condition, plus empty Git repositories outside the SkillWire hierarchy.
Copy only the existing Codex authentication file into each disposable profile
with mode `0600`, or complete Codex's OAuth flow there. Configure the same
SkillWire MCP connection using a protected bearer environment-variable reference
or OAuth. Never print, persist in evidence, or put a credential value in
marketplace, plugin, Git, or repository files. Remove all disposable profiles,
repositories, credential copies, Git rewrites, and generated secrets after
validation.

Before the first case, prove that each repository has no `AGENTS.md`, `.agents`,
`.codex`, plugin, or repository instructions. Categorize the effective inventory
as platform-baseline, user, repository, admin, plugin, and MCP. User,
repository, and admin inventories must be empty. The server-only plugin
inventory must be empty. The adapter inventory must contain exactly
`skillwire-autonomous-activation:autonomous-skill-activation`. Both MCP
inventories must contain only `skillwire`. Unavoidable Codex system skills are
platform baseline and must match between conditions.

Install the adapter only in the adapter profile, in this order:

```text
codex plugin marketplace add <configured-skillwire-marketplace> --ref <release-ref> --json
codex plugin list --marketplace skillwire --available --json
codex plugin add skillwire-autonomous-activation@skillwire --json
codex plugin list --marketplace skillwire --json
codex mcp list --json
```

The configured marketplace must resolve the exact source commit in
`distribution/codex-marketplace/marketplace.json`. The manager-owned installed
copy must match `distribution/codex-marketplace/release-integrity.json`. No
application or operator script may copy the plugin into `CODEX_HOME` directly.

Each case starts in a fresh ephemeral Codex session. Use the prompt from
`evaluation/autonomous-activation.v1.json` byte-for-byte, without adding
SkillWire, MCP, tool, or exact-skill names unless those words already occur in
an explicit frozen case. Pin Codex CLI `0.147.0`, one model and version, and one
reasoning setting for both conditions. Set the per-case timeout to 180 seconds
for both conditions and allow exactly one attempt. Mark timeouts, interrupted
commands, malformed traces, and external failures `incomplete`; never drop or
reinterpret them. Snapshot the client repository before and after every case.

## Cohorts

The release-candidate pilot uses the exact ordered case IDs in
`evaluation/autonomous-activation-release-subset.v1.json`. That subset was
selected independently of outcomes by taking the first cases in immutable
source-corpus order within each stratum:

- 8 clean automatic-relevant cases without local fixtures or injected failures;
- 3 irrelevant cases;
- 2 explicit user-requested cases;
- the corresponding 2 paired no-intent cases.

Both conditions run the same 15 IDs in the declared order. Previously completed
server-only observations may be reused only when their IDs belong to this subset
and all other pinned controls match. Never select, drop, retry, or reorder a
case because of its outcome or latency. Report clean automatic, irrelevant,
explicit, and no-intent results independently. Injected service, authentication,
rate-limit, exact-revision, memory, and resource failures remain outside the
paired clean claim denominator.

The result is pilot/release-candidate evidence for the recorded configuration,
not a statistically definitive or universal claim. The 30-case 15/5/5/5 pair is
an optional, separately identified, non-blocking extended benchmark. The
original 65 non-overlap cases are an optional expanded benchmark. Neither may
replace or be merged into the 15-case pilot artifact.

For the overlap cohort, provision only the operator-controlled synthetic local
inventory described by `tests/fixtures/activation/local-inventory.v1.json`.
Never install those fixtures in this repository. An equivalent or explicitly
selected local skill must not be silently overridden, and local use must not be
attributed to SkillWire. Report these five cases separately from the clean pair.

## Trace collection and redaction

Capture operations from a server-side observer proxy or an authenticated server
trace. Set a case ID before each fresh session and close its trace afterward.
Evidence must prove actual ordered calls; skill invocation, model reasoning, and
textual claims in the final answer are insufficient. Retain only:

- frozen case ID;
- instruction method and whether the exact policy was observed;
- operation name, sequence, automatic/user-requested context, public frozen
  identity, declared resource path, result, and safe categorical error code;
- verified SkillWire load identity, completion-evidence category, outcome flag,
  and client-write/GitHub-request counts.

Never retain raw prompts, task summaries, repository hashes, local paths, skill
instructions, resource bodies, credentials, tokens, headers, or unrelated
conversation. A successful `load_skill` with matching exact identity, revision
SHA-256, provenance, and advisory status is the only evidence of
SkillWire-delivered guidance. A search result, adapter invocation, or similarly
named local skill is not attribution.

## Expected behavior

For unchanged intent, the maximum automatic path is:

```text
search_skills(automatic)
  -> one relevant preview
  -> load_skill(exact skillId and revision)
  -> optionally read_skill_resource(one useful declared path, once)
```

Empty results and all failures end the SkillWire attempt. Record any retry,
reformulation, polling, context escalation, second candidate, revision
substitution, or duplicate resource as a violation. The harness should continue
ordinary work, but fail-open continuation is advisory behavior rather than a
server-enforceable guarantee.

Use `user-requested` only when the active frozen prompt explicitly requests the
relevant skill or context. Record a useful outcome only after a verified load
and either observed task completion or explicit user feedback. Incomplete cases
remain outside success denominators.

## Evidence validation

Write each temporary run as privacy-safe v1 evidence, then compose the pair
without changing either run. The final envelope must conform to
`specs/003-autonomous-skill-activation/contracts/paired-adapter-evidence.schema.json`
and bind the historical baseline. Validate with:

```bash
pnpm exec tsx scripts/activation-evidence.ts validate-pair --input evaluation/evidence/003/adapter-pair-v1.json
pnpm exec tsx scripts/activation-evidence.ts summarize-pair --input evaluation/evidence/003/adapter-pair-v1.json
```

The commands bind the exact release-subset ID/order and recompute both v1 runs,
inventories, metrics, exact workflow attribution, and claim eligibility. They
never launch Codex or enter required CI. Individual-run debugging remains
available with:

```bash
pnpm exec tsx scripts/activation-evidence.ts validate --input /absolute/operator/evidence.json
pnpm exec tsx scripts/activation-evidence.ts summarize --input /absolute/operator/evidence.json
```

## Acceptance report and cleanup

Report the initial targets without merging cohorts:

- attributable spontaneous activation on the 8 selected clean prompts: at least
  80%;
- exact selection after search: at least 90%;
- unnecessary search on the 3 selected irrelevant prompts: no more than 10%;
- user-requested isolation across the 2 selected pairs: 100%;
- client-tree writes: zero.

Also report progressive-loading conformance, local equivalent/overlap counts and
violations, agent-facing GitHub requests, incomplete cases, and harness
limitations. A harness or adapter cohort may record zero activation; that is
valid negative evidence and must not be rewritten as a server, plugin, or model
success. Manual evidence is reproducible release evidence, never a required CI
gate. Even a passing result supports only the qualified release-candidate claim
for the pinned configuration.

After the pair, remove the adapter with
`codex plugin remove skillwire-autonomous-activation@skillwire --json`, start a
new session, and prove one explicit SkillWire MCP operation remains available
through the independent connection. Remove the marketplace only after that
check. Confirm the client repository digest is unchanged and no remote skill
content remains installed.

## Recorded release-candidate pilot

The paired artifact is `evaluation/evidence/003/adapter-pair-v1.json`. Both
conditions used the same frozen 15 IDs, Codex CLI `0.147.0`, model
`gpt-5.6-sol`, `xhigh` reasoning, 180-second timeout, observer, one-attempt
rule, SkillWire revision, endpoint, and protected authentication mechanism.

The server-only condition completed seven of eight automatic cases with zero
SkillWire operations; the remaining selected automatic case timed out and is
recorded as incomplete. It also made zero calls for the three irrelevant, two
explicit, and two no-intent cases. The server-only cohort therefore remains
negative evidence and does not replace the immutable historical `0/7` artifact.

The adapter condition produced attributable automatic-context `search_skills` ->
exact `load_skill` traces in all seven completed automatic cases. The eighth
selected automatic case reached the same attributable chain but timed out at 180
seconds and remains incomplete; it is not counted positive. Both explicit cases
used `user-requested` search and loaded the expected exact opt-in revision. All
three irrelevant cases made no SkillWire call. One no-intent case made one
unnecessary automatic search but did not load the user-only skill; the other
made no call. All repositories remained unchanged and no agent-facing GitHub
request occurred.

The completed-case diagnostics are spontaneous activation `7/7`, correct exact
selection `9/9`, irrelevant activation `0/3`, and user-requested isolation
`2/2`. Progressive-loading conformance is only `3/9`: six exact loads read an
unnecessary resource, including one explicit case. These are observed pilot
rates, not a statistically definitive estimate. The validator therefore keeps
`claimEligibility.eligible=false` with `insufficient-relevant-cases`,
`progressive-loading-conformance-failed`, `incomplete-observations`, and
`unattributable-success-trace`. The plugin remains experimental and no
autonomous-activation claim is made.

The separate privacy-safe overlap artifact is
`evaluation/evidence/003/local-overlap-v1.json`. All five predeclared overlap
cases completed in each condition with zero SkillWire operations, zero verified
remote loads or overrides, zero client-tree writes, and zero local-inventory
writes. These ten observations remain outside the clean pilot denominator.
