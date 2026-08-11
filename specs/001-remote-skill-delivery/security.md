# Security and Privacy Decisions: Remote Skill Delivery MVP

## Security Invariants

1. Catalog content crosses the client boundary only as MCP response data; SkillWire never installs or
   executes it.
2. Every MCP operation authenticates exactly one account before argument-dependent access.
3. MCP callers cannot submit source URLs, release references, GitHub repositories, or fetch targets.
4. Published revision identity, provenance, instructions, manifest, resource hashes, and resources
   are immutable and hash-bound.
5. Current advisory state is separate, version-controlled, release-anchored, and read-only at
   runtime.
6. Repository memory is stored and queried only in the authoritative PostgreSQL database. It is
   never cached.
7. A successful forget response follows committed tenant-scoped deletion and reveals no prior
   existence or removed count.
8. Expired audit events are unconditionally excluded from all reads and behavior.
9. Catalog verification cannot write files or connect to the application database.

## Trust Boundaries

| Boundary | Trusted inputs | Untrusted inputs | Enforcement |
|----------|----------------|------------------|-------------|
| MCP caller | Authenticated account after key verification | Headers, envelopes, tool arguments, task text, repository hashes | Host/body/rate controls, strict Zod schemas, tenant context |
| Catalog source | Exact version-controlled allowlist and release configuration | Skill Markdown, resources, provenance files | Safe paths, strict text/size/schema checks, canonical hashes |
| Published batch | Atomic create-only release directory | Any later filesystem drift | Complete read-only verification before runtime use |
| Catalog cache | Verified immutable complete bundles | Partial, stale, wrong-hash entries | Immutable cache key and full re-verification |
| PostgreSQL | Parameterized tenant-scoped store | Caller identifiers and concurrency | Account/repository predicates, transactions, constraints |
| GitHub CI | Configured repository and read-only token | API responses, tag names, tag objects, prior bytes | Fixed API origin, schema/length checks, exact commit resolution, fail closed |
| Client filesystem | None; SkillWire has no client path capability | Any attempt to install/materialize | Schemas expose no client path; end-to-end snapshots |

## Bearer API Keys

- Token format separates a public lookup ID from a high-entropy secret.
- PostgreSQL stores only key ID, account ID, keyed digest, lifecycle timestamps, and status.
- A deployment pepper comes from a secret mount and is never stored in the database or logs.
- Digests are compared in constant time.
- Expired/revoked keys and disabled accounts produce the same external 401 shape as unknown keys.
- Authentication state is not cached; revocation applies to the next request.
- Rotation permits a bounded overlap before explicit old-key revocation.
- Authorization headers, token fragments, digests, and pepper values are recursively redacted.

## Tenant and Repository Isolation

- Account ID comes only from the authenticated principal.
- Repository hash must match exactly 64 lowercase hexadecimal characters and is treated as opaque.
- Every repository-memory SQL statement includes both `account_id` and `repository_hash`.
- A repository hash is not a credential and can never select another account.
- The raw hash appears only in the repository-memory table and transient parameter binding; it is
  absent from logs and erasure audit.
- Repository-memory results are not retained after request completion.
- Two accounts using the same hash remain separate; two hashes in one account remain separate.

## SSRF and Network Boundaries

MCP schemas contain no URL, host, repository, tag, commit, or source field. Unknown nested fields are
rejected recursively. The bundled runtime provider performs no network I/O.

The only GitHub network access belongs to `catalog:verify` in CI:

- API base is the configured GitHub API origin, not caller data.
- Repository comes from trusted CI configuration and must match strict `owner/repo` syntax.
- Token permission is `contents: read` only.
- Only paginated release-list, exact tag/reference objects, and exact commit-addressed content reads
  are permitted.
- Redirects to a different origin, unexpected media types, oversized responses, invalid JSON, and
  timeouts fail closed.
- Tag names are path-encoded and never passed to a shell.

No GitHub access exists in the runtime MCP service.

## Resource and Text Safety

- Normalize and validate manifest paths before filesystem access.
- Reject absolute paths, dot segments, percent/double encoding, backslashes, NUL, symlinks,
  duplicates, undeclared paths, and containment escapes.
- Open only regular files beneath the fixed allowlisted catalog root and protect against TOCTOU.
- Decode strict UTF-8; reject binary, invalid UTF-8, NUL, unsupported media, and size violations.
- Treat embedded commands, package instructions, code fences, and hooks as inert text.
- Production dependencies/imports prohibit child processes, VM evaluation, installers, package
  managers, and catalog-driven dynamic import.

## Atomic Create-Only Publication

`publish` is offline and the only catalog-writing capability.

- Validate exact inventory, all ten source bundles, complete provenance, paths, sizes, canonical
  bytes, resource hashes, bundle hashes, advisories, release arguments, and duplicate identities
  before creating published state.
- Stage the complete release directory as a sibling on the same filesystem.
- Atomically create an exclusive publication claim before rescanning published revisions; hold it
  through the final rename.
- Close and sync all staged files before one rename to a previously absent final path.
- Reject any existing/stale claim, final release path, or revision identity; never overwrite or
  automatically reclaim a claim.
- A pre-rename failure exposes no batch. A post-rename batch is complete and independently
  traceable for all ten revisions.
- Publication reads/writes catalog files only and never connects to PostgreSQL.

Command tests inject failures after every stage and verify that the final release path is either
absent or complete—never partial. Concurrent invocations produce exactly one publisher; a stale
claim fails closed. A post-rename claim-cleanup failure cannot relabel the already-created batch as
rejected; it emits a bounded diagnostic and safely blocks later publication.

## Strictly Read-Only Verification

`verify` recalculates inventory, bundle, resource, advisory, and release integrity and reports drift.
It has no repair mode.

- Its dependency graph excludes the publisher, writable filesystem adapter, migrations, and all
  PostgreSQL code.
- Contract tests deny filesystem write APIs and provide no database service.
- A present publication claim makes verification invalid; verification never removes it.
- The catalog is mounted read-only in verification and runtime containers.
- Workspace snapshots and database probes are identical before and after every success/failure.
- GitHub baseline calls are read-only and cannot publish releases, change refs, or edit contents.

## Advisory Release Integrity

Advisory events contain monotonic sequence, previous-event hash, and their own canonical SHA-256.
The release record contains the verified chain head.

Genesis requires explicit `genesis: true`, null `previousReleaseCommit`, no previous local batch,
an initial local chain, and a successful fully paginated GitHub check proving no non-draft release,
including no prerelease. API unavailability is not absence.

For non-genesis verification:

1. Fully paginate GitHub releases, filter `draft: false`, and select the unique greatest valid
   `published_at`; published prereleases remain eligible and a timestamp tie fails closed.
2. Resolve the selected release's exact tag reference and peel annotated tags to a commit.
3. Require a 40-character lowercase commit SHA equal to release metadata.
4. Retrieve prior advisory bytes from the global advisory path at that exact SHA; validate candidate
   release metadata locally.
5. Require an unchanged prior byte prefix and validate the proposed append/head.

Missing/unavailable release, tag, commit, metadata, or content fails closed. Merge bases, branches,
`target_commitish`, and fallback references are forbidden. Runtime verifies only the already
published local chain/head and cannot edit either.

## Verified Immutable Catalog Cache

- Key: release ID + skill ID + exact revision + recorded bundle SHA-256.
- Value: complete normalized instructions, provenance, manifest, and every resource.
- Admission requires complete validation and bundle/resource hash checks.
- Fallback serving re-verifies the complete bundle.
- Partial, extra, mismatched, or advisory-revoked entries are rejected.
- The cache contains no repository memory, API-key state, audit rows, or client data and needs no
  mutable invalidation protocol.

## PostgreSQL Repository-Memory Erasure

`forget_repo_memory` runs one tenant-scoped transaction:

1. delete every matching usage/outcome row;
2. insert one six-field audit row using database time;
3. commit;
4. return constant `{ forgotten: true }`.

There is no repository-memory cache, scope lock, distributed lock, or invalidation failure mode.
Database failure rolls back and returns a bounded retryable error. Empty scopes and retries use the
same success shape. Other accounts, hashes, and catalog files are unaffected.

Backups, WAL, snapshots, restore processes, database replicas, and physical storage remain outside
the service's API guarantee and credentials.

## Audit Expiration and Readiness

- `expires_at` equals the same row's `created_at + interval '30 days'`.
- Every application audit query adds `expires_at > database_now`; no caller or code path may opt out.
- Cleanup deletes `expires_at <= database_now` idempotently.
- Startup cleanup completes before readiness is true; database outage/recovery returns the service
  to this not-ready cleanup state.
- Cleanup repeats hourly. With continuous service and database availability, physical delay after
  expiration is at most one hour.
- While the database is unavailable, SkillWire makes no physical-deletion guarantee; logical expiry
  remains the application rule once queries can execute.
- Audit/log output contains no repository hash, skill ID, outcome, query, or usage detail.

## HTTP, Logging, and Safe Failures

- Validate Host before authentication and arguments; bind/container host allowlists explicitly.
- Enforce body/task/content/response/rate/deadline limits before sensitive access.
- Structured event fields are allowlisted; nested secret, task, path, repository, SQL, and content
  keys are recursively redacted.
- Authentication failures are indistinguishable.
- Integrity failure returns no partial or substituted content.
- Readiness and cleanup failures expose no row counts or identifiers.
- Error responses include only bounded codes, retryability, and request ID.

## Mandatory Security Evidence

- Authentication lifecycle and indistinguishable failures.
- Cross-account and cross-repository PostgreSQL isolation.
- Exact-version and provenance substitution rejection.
- Atomic all-or-nothing publication and duplicate refusal.
- Verifier no-write/no-database behavior.
- Genesis and non-genesis GitHub baseline failure matrix.
- Resource path, text, size, hash, SSRF, and execution boundaries.
- Direct-database repository memory and idempotent erasure/restart behavior.
- Unconditional logical audit expiry and availability-qualified physical cleanup/readiness.
- No-client-write snapshots across success, failure, retry, and catalog-cache paths.
