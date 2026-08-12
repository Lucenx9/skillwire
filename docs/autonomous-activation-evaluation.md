# Autonomous Activation Evaluation

Feature 003 publishes advisory MCP server instructions. SkillWire cannot force
an arbitrary agent harness to read those instructions or invoke a tool. This
protocol measures actual harness behavior separately from deterministic server
CI; graphical interfaces, launchers, and harness configuration are outside the
SkillWire system boundary.

## Required setup

Record the exact SkillWire policy, frozen corpus, catalog, local-inventory, MCP
protocol, harness, model, evaluator, and environment-profile versions. Configure
the candidate server through the operator's normal MCP mechanism outside the
evaluated client repository. Do not add client configuration, activation files,
local skills, or SkillWire content to that repository.

Each case starts in a fresh agent session. Clean-profile cases must have no
matching local skill. Use the prompt from
`evaluation/autonomous-activation.v1.json` verbatim, without mentioning
SkillWire, MCP, or tool names unless the frozen case is explicitly
user-requested. Snapshot or digest the client tree before and after the case.

## Cohorts

Run and report these groups independently:

- clean automatic-relevant prompts;
- trivial and irrelevant prompts;
- paired explicit user-requested and no-intent prompts;
- the versioned metadata-only local-overlap inventory;
- service, authentication, rate-limit, exact-revision, memory, and resource
  failures.

For the overlap cohort, provision only the operator-controlled synthetic local
inventory described by `tests/fixtures/activation/local-inventory.v1.json`.
Never install those fixtures in this repository. An equivalent or explicitly
selected local skill must not be silently overridden, and local use must not be
attributed to SkillWire.

## Trace collection and redaction

Capture operations from a harness export or observer proxy. Evidence must prove
actual ordered calls; textual claims in the final answer are insufficient.
Retain only:

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
SkillWire-delivered guidance. A search result or similarly named local skill is
not attribution.

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

Write privacy-safe evidence conforming to
`specs/003-autonomous-skill-activation/contracts/manual-evidence.schema.json`,
then run:

```bash
pnpm exec tsx scripts/activation-evidence.ts validate --input /absolute/operator/evidence.json
pnpm exec tsx scripts/activation-evidence.ts summarize --input /absolute/operator/evidence.json
```

Both commands are offline readers. They do not launch, configure, or contact a
harness and do not write the client tree. The validator binds versions,
recomputes diagnostics and metrics from per-case traces, rejects unsupported
positive outcomes and unsafe attribution, and keeps local-overlap metrics
separate.

## Acceptance report

Report the initial targets without merging cohorts:

- spontaneous search on relevant clean prompts: at least 80%;
- exact selection after search: at least 90%;
- unnecessary search on irrelevant prompts: no more than 10%;
- user-requested isolation: 100%;
- client-tree writes: zero.

Also report progressive-loading conformance, local equivalent/overlap counts and
violations, agent-facing GitHub requests, incomplete cases, and harness
limitations. A harness that ignores server instructions may record zero
activation; that is valid negative evidence and must not be rewritten as a
server or model success. This manual report is reproducible release evidence,
never a required CI gate.
