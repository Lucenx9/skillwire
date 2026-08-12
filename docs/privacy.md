# Privacy, erasure, and backup boundaries

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

Do not represent `forget_repo_memory` as proof that operator-controlled
historical copies have been physically destroyed.

Autonomous activation does not change retention or erasure. `forget_repo_memory`
continues deleting the authenticated account's live opaque-hash namespace
transactionally; evaluation evidence is a separate operator-managed release
artifact subject to the redaction rules above.
