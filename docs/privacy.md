# Privacy, erasure, and backup boundaries

## Repository memory

SkillWire stores only the authenticated account ID, an opaque 64-character
repository hash, exact skill/revision/hash identity, aggregate usage
timestamps/count, and the current bounded outcome. It stores no source code,
repository name, remote URL, local path, raw Git metadata, query, prompt, skill
body, resource body, or client secret. Every read and mutation predicates on
both account and repository hash directly in PostgreSQL.

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
