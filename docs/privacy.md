# Privacy, erasure, and backup boundaries

## Self-hosted credentials and local state

The service has four distinct secret classes: PostgreSQL password, application
API-key pepper, per-client bearer keys, and an optional read-only GitHub source
token. Service secrets are independent 256-bit values in owner-only files.
Client keys prefer Linux Secret Service and otherwise use only a separately
confirmed `0600` protected-file fallback. The GitHub token has a separate
`github-source-read-only` credential identity and is never a client key. Raw
values cross process boundaries only through stdin, a private descriptor/FIFO,
or a restrictive mounted secret file—not argv or environment values.

Installation state contains references, hashes, versions, ownership identities,
and categorical health only. Operation journals, previews, terminal output,
logs, snapshots, backup manifests, release evidence, and diagnostics must not
contain raw tokens, Authorization headers, task text, repository names or paths,
or skill/resource bodies. Normal Codex and Claude profiles keep only the
credential-free launcher command and installation/client identifiers; the bridge
resolves the protected client credential at request time.

## Repository memory

SkillWire stores only the authenticated account ID, an opaque 64-character
repository hash, exact skill/revision/hash identity, aggregate usage
timestamps/count, and the current bounded outcome. It stores no source code,
repository name, remote URL, local path, raw Git metadata, query, prompt, skill
body, resource body, or client secret. Every read and mutation predicates on
both account and repository hash directly in PostgreSQL.

Autonomous search callers should send the shortest non-sensitive task summary
that can distinguish the specialized procedure. They must not send repository
content, paths, URLs, credentials, headers, tokens, or unrelated conversation.
The optional repository hash remains the existing opaque lowercase SHA-256
fingerprint; it is never a path or repository name and is prohibited from logs
and manual evidence.

Repository usage is attributable only after `load_skill` returns an exact
revision whose identity, bundle hash, provenance, advisory state, instructions,
and resources have been verified. Search previews, similarly named local skills,
failed or cancelled loads, and resource reads do not create usage. A local skill
can never be inferred to have come from SkillWire. Outcomes still require an
existing exact usage row, and a positive outcome additionally requires
completed-task evidence or explicit user feedback at the harness boundary.

MCP instructions, descriptions, loaded instructions, and resources are inert
untrusted response data. No input accepts a client filesystem target and no
operation installs content or writes a client tree. Agent-facing operations do
not contact GitHub; imported content is served only from verified PostgreSQL
bundles.

Manual activation evidence uses frozen case IDs rather than prompt or task text.
It may contain only operation names, invocation context, public frozen
identities and declared paths, safe error categories, completion-evidence
categories, and aggregate counters. It must exclude raw prompts, task summaries,
repository hashes, local paths, instruction/resource bodies, credentials,
tokens, headers, and unrelated conversation. Production security events follow
the same content prohibition.

The experimental Codex adapter is limited to three text files under its plugin
package: `.codex-plugin/plugin.json`,
`skills/autonomous-skill-activation/SKILL.md`, and
`skills/autonomous-skill-activation/agents/openai.yaml`. Those files may contain
only activation guidance, one credential-free MCP dependency, version data, and
uninstall metadata. They must never contain remote skill instructions or
resources, API keys, bearer tokens, authorization headers, repository hashes,
account or tenant identifiers, generated credentials, or user data.

Only the Codex plugin manager may create or remove the allowlisted adapter files
in its managed user-scope directories. SkillWire application code does not write
there. The manager lifecycle must leave client repositories unchanged, must not
materialize remote skill content locally, and must preserve external MCP
credentials and unrelated configuration on upgrade, rollback, or uninstall.
Evaluation inventories record only categorized public component identifiers;
temporary profiles, out-of-tree repositories, credential copies, observer state,
and generated secrets are deleted after privacy-safe evidence validation.

## Live erasure guarantee

`forget_repo_memory` performs one transaction that deletes the matching live
usage/outcome rows and inserts a privacy-safe audit event. The response is
acknowledged only after commit and always has the same `{"forgotten":true}`
shape. It never returns a removed count or indicates whether the scope
previously existed.

The audit event contains only account ID, request ID, timestamps, a bounded
operation result, and an aggregate count unavailable to the caller. It contains
no repository hash, skill ID, outcome, or content.

## Audit expiration

Audit rows expire exactly 30 days after their database-assigned creation time.
Every application read filters out `expires_at <= database_now`, so logical
expiration does not depend on cleanup. Startup removes expired rows before
readiness becomes true; an hourly idempotent scheduler repeats cleanup. The
one-hour physical cleanup bound applies only while the service and PostgreSQL
remain continuously available. After downtime, cleanup must succeed before
readiness recovers.

## Backups, WAL, snapshots, and physical media

The API guarantee covers the authoritative live PostgreSQL database only.
SkillWire does not manage database backups, WAL archives, replicas, filesystem
snapshots, restore workflows, or physical media. Deployment operators must
define retention, encryption, access, restore, and deletion policies for those
systems. Restoring an older backup can reintroduce live repository-memory rows;
operators must reconcile restore procedures with erasure obligations before
reopening traffic.

The migration-010 maintenance procedure therefore requires an
operator-supported, independently restorable pre-upgrade backup and an isolated
restore check. Crossing back from schema 010 requires restoring that backup
together with the matching old application; rolling back only the application
image is prohibited. See [deployment and operations](operations.md#migrations).

Do not represent `forget_repo_memory` as proof that operator-controlled
historical copies have been physically destroyed.

Autonomous activation does not change retention or erasure. `forget_repo_memory`
continues deleting the authenticated account's live opaque-hash namespace
transactionally; evaluation evidence is a separate operator-managed release
artifact subject to the redaction rules above.
