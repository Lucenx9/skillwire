# Testing Strategy: GitHub Catalog Ingestion

## Required Test Principles

- Required CI is deterministic and performs zero live network access.
- The fixed acceptance source is
  `mattpocock/skills@84fdeffd12f2ee307994d1eb6feb48173b6e0502`.
- Feature 001's complete existing suite is a compatibility gate, not a sampled regression suite.
- PostgreSQL behavior uses real PostgreSQL through the existing Testcontainers infrastructure.
- Every test observes public contracts or stable module ports; no test treats a mutable GitHub branch
  as immutable truth.
- Security failure, retry, rate-limit, cache, cancellation, and erasure paths receive the same
  no-client-write assertion as successful search/load/resource.

## Fixture Architecture

Required fixtures live under:

```text
tests/fixtures/github-ingestion/
└── mattpocock-skills-84fdeffd12f2ee307994d1eb6feb48173b6e0502/
    ├── routes.json
    ├── expected-inventory.json
    ├── responses/
    │   ├── repository.json
    │   ├── default-ref.json
    │   ├── commit.json
    │   ├── tree.json
    │   ├── manifest-blob.json
    │   ├── license-blob.json
    │   ├── skill-*.json
    │   └── resource-*.json
    └── mutations/
```

`routes.json` records method, exact `api.github.com` path/query, status, selected ETag/rate/Link
headers, response file, and response fixture SHA-256. The injected fetch implementation:

- accepts only fixed official-origin requests;
- rejects missing, unexpected, duplicate-beyond-count, or unused required routes;
- enforces production redirect, streaming, deadline, pagination, and schema behavior;
- has no fallback to the internet.

`expected-inventory.json` is independently reviewed and immutable. It asserts:

- plugin manifest version 1.2.3 and exactly 25 unique declared skill paths/names;
- exact commit and repository/tree/manifest/license identities;
- MIT license and Matt Pocock attribution on every published revision;
- exactly 14 user-only skills: `ask-matt`, `grill-with-docs`, `implement`,
  `improve-codebase-architecture`, `setup-matt-pocock-skills`, `to-spec`, `to-tickets`, `triage`,
  `wayfinder`, `grill-me`, `handoff`, `teach`, `to-questionnaire`, and `wait-what`;
- `grill-with-docs` depends on exactly `grilling` and `domain-modeling`;
- safe progressive resources including `ask-matt/PHASE-BOUNDARIES.md`, `tdd/tests.md`,
  `tdd/mocking.md`, `domain-modeling/CONTEXT-FORMAT.md`, and
  `domain-modeling/ADR-FORMAT.md`;
- script references such as `wizard/template.sh` never become resources.

Mutation fixtures derive from reviewed base fixtures and update their route hashes explicitly; tests
never modify the base acceptance set in place.

## Unit Tests

### GitHub client and object model

- owner/repository component validation and encoding
- fixed origin, version, headers, one validated repository-rename hop, all other redirect rejection,
  endpoint allowlist
- ETag/body binding and 304 cache-miss failure
- Link agreement, integer pagination, incomplete results, and every budget edge
- retryable/non-retryable status matrix, Retry-After/rate reset, shared deadline, aborted wait/body
- response-stream caps independent of Content-Length
- repository/ref/commit/tree/blob Zod schemas and exact SHA transitions
- tree path normalization, duplicate/NFC/case collisions, object mode/type policy
- Base64, size, UTF-8, NUL, content hash, and aggregate-budget validation

### Parsers and policy

- strict plugin JSON and manifest-authoritative selection
- nested multiple `SKILL.md` discovery only when no recognized manifest exists
- frontmatter boundaries, YAML aliases/anchors/tags/merge/duplicates/prototype/coercion/depth/count
- Markdown links versus code, HTML, image, remote/data/root/fragment/query/prose references
- safe resource resolution and text-only classification
- SPDX allowlist, license precedence/conflict, notice/attribution completeness
- exact same-source dependency inference, evidence locator, missing/ambiguous/self/cycle behavior
- classification transition table and stable sorted findings
- canonical schema v2 bytes, bundle/content-identity hashes, v1 byte preservation
- changed versus unchanged content and collision behavior
- invocation filtering before ranking and memory boost only after positive textual relevance

## Contract Tests

### MCP

- The tool inventory remains exactly six names.
- Existing Feature 001 JSON requests and responses validate unchanged.
- Search input accepts optional `invocationContext`, defaults missing to automatic, and rejects every
  network/source field and extra property.
- First-party and imported preview/load discriminated unions produce schema-drift JSON Schemas.
- Imported search is preview-only and exposes exact source/trust/classification/invocation metadata
  without instruction/resource/license bodies or validation evidence.
- Imported load exposes instructions, provenance, invocation mode, dependencies, resource manifest,
  and no resource body; resource read returns exactly one body.
- Unknown/discovered/quarantined/revoked/unavailable behavior matches the contract.
- Memory tool schemas and outcomes remain unchanged for imported IDs/revisions.

### Administrator CLI

- Every command grammar, output JSON, exit status, idempotence, and stable error.
- Unknown/duplicate/missing/prohibited flags, URL-shaped coordinates, mutable refs, and individual
  skill attempts fail before side effects.
- Operator/config/lease/cancellation failures and redaction.
- Architecture test proves the existing read-only `catalog:verify` executable cannot import any
  ingestion writer, PostgreSQL source store, scheduler, or admin module and performs no write.

### GitHub provider

- Typed port to exact endpoint mapping, fixed headers/origin, pagination and ETag contract, error
  normalization, and no URL-accepting method.

## PostgreSQL Integration Tests

Run against a real current PostgreSQL version in CI:

1. Apply/upgrade migrations `001` through `006`, preserve existing Feature 001 rows, validate
   checksums, required indexes, constraints, privileges, and immutable triggers.
2. Register the same numeric repository through casing/alias/rename variants and produce one source,
   registration, skill identity set, and active sync.
3. Exercise two-instance global/per-source lease acquisition, renewal, expiry/takeover, higher
   fencing token, stale commit rejection, graceful release, and crash recovery.
4. Publish the 25 acceptance revisions atomically. Query from another connection before/after commit
   to prove the source head changes all at once.
5. Inject failure after each content/revision/resource/dependency/report/classification/advisory/head
   step and prove rollback leaves the prior visible catalog unchanged.
6. Reprocess the same commit and a later commit with changed, unchanged, added, and removed skills.
   Assert snapshot/revision/resource/dependency/content deduplication and equality observations.
7. Attempt same-hash/different-body and same-identity/different-canonical-byte collisions; fail closed.
8. Prove current classification projection, append-only history, curation authority, and no inherited
   curation for changed content.
9. Append external advisory events concurrently, verify hash chain/head, unavailable exact read,
   revoked denial, no deletion event from incomplete acquisition, and source-wide unavailability
   only after the full repeated-confirmation window.
10. Restart service/containers and prove sources, schedules, leases, immutable revisions, provider
    visibility, repository memory, and advisory state persist.
11. Cancel/expire deadline at each final-transaction boundary and prove no late publication,
    classification, advisory, terminal success, or usage-memory write.

## Security Tests

The adversarial suite uses table-driven mutations for:

- alternate schemes/hosts/ports, URL credentials, redirects, hostile Location/Link/download/raw/
  license/content URLs, encoded separators, Unicode confusables, and unexpected endpoints;
- malformed/oversized JSON, pages, incomplete search, trees, path collisions, unsupported modes,
  submodules/symlinks/executables, SHA/size/encoding mismatch, response replacement, invalid
  Base64/UTF-8/NUL/binary and compression/byte-count mismatches;
- absolute/root/traversal/double-encoded/backslash/query/fragment/directory/outside-root/undeclared
  resources and extension/MIME spoofing;
- plugin/YAML/Markdown parser attacks and AST/node/depth/alias expansion;
- missing/unsupported/conflicting licenses/attribution and missing/ambiguous/cyclic/cross-repository
  dependencies;
- schema stuffing on every agent tool, authentication/account/key/rate/deadline failure, guessed
  quarantined identities, and repository-memory account/repository isolation;
- log/audit redaction for token, owner/repository, URL, path, commit/blob hash, manifest/frontmatter,
  query, repository hash, license/instruction/resource bodies, dependency excerpts, and nested errors;
- static/runtime proof that ingestion never invokes `child_process`, shells, package managers, clone,
  checkout, hooks, binaries, workflows, dynamic module loading from content, or filesystem writes.

## End-to-End Tests

### Acceptance import

1. Add `mattpocock/skills` once through the admin CLI against the recorded default ref pinned to the
   acceptance commit.
2. Let the in-process scheduler acquire the PostgreSQL lease and publish the snapshot.
3. Assert 25 visible verified revisions, exact inventory/license/attribution/commit/source paths,
   user-only modes, safe resources, and dependency edges.
4. Repeat registration and sync; assert no duplicates.

### Three-call remote journey

- In explicit `user-requested` context, search for `ask-matt`; load the returned exact revision; read
  `PHASE-BOUNDARIES.md`. Complete in at most three MCP calls.
- Snapshot the client tree before/after and assert byte-for-byte equality.
- Search response has no content bodies; load has no resource/license body; resource returns only the
  requested body.
- With missing/automatic context, the same user-only skill is absent even for an exact-name task.
- Load `grill-with-docs` and assert only the two exact same-source dependencies.

### Synchronization and safety paths

- Changed/unchanged/deleted/renamed fixture sequence, repeated commit, rate limit, transient outage,
  corrupt cache, quarantine, cancellation, provider restart, unavailable/revoked advisory, and
  repository memory/erasure.
- Each path snapshots the client tree and records zero GitHub call from any MCP request.

## Evaluation Gates

- Add at least 40 immutable imported-skill search cases containing relevant, irrelevant, ambiguous,
  user-only automatic, explicit user-requested, classification/advisory, and repository-memory cases.
- At least 90% of relevant eligible imported cases must place an expected skill within the fixture's
  accepted rank window; 100% of forbidden visibility cases must return no forbidden skill.
- Preserve every existing Feature 001 search threshold.
- Add at least 25 immutable imported three-call journeys (one per acceptance skill; resource-less
  skills stop after exact load) and require at least 90% complete within the specified call budget;
  all safety/no-write/provenance assertions remain 100% gates.
- Measure registration/synchronization duration under recorded normal responses; at least 95% of
  accepted in-budget cases reach published/quarantined terminal result within five minutes.

## CI and Manual Validation

Required CI order:

1. frozen-lockfile install
2. formatting, ESLint, strict typecheck, build
3. migrations and Feature 001 catalog/advisory verification
4. unit and MCP/provider/CLI contracts
5. PostgreSQL integration and fixture ingestion
6. security/adversarial/no-execution/no-client-write suites
7. all E2E and evaluation gates
8. Docker/Compose readiness/restart/shutdown checks and `git diff --check`

The manual live-GitHub workflow is nonblocking, requires an explicit secret token, reads the fixed
pinned acceptance commit into a disposable PostgreSQL database, and reports differences without
updating required fixtures automatically.

## Completion Evidence

Implementation is not complete until the full existing Feature 001 suite plus every new required
suite passes, required CI shows zero network fallback, fixture inventory/hashes are reviewable, and a
clean client-tree diff is proven across normal and adversarial paths.
