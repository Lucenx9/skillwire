# Research: GitHub Catalog Ingestion

## Decision 1: Use Node.js 24 Native `fetch`

**Decision**: Implement a narrow `GitHubRestClient` with Node.js 24 built-in `fetch`. Do not add
Octokit for this feature.

**Rationale**:

- The feature uses a small fixed set of read-only REST endpoints. Native `fetch` already supports
  abort signals and can share one absolute operation deadline across request streaming, retry waits,
  and subsequent attempts.
- A local adapter can reject redirects, construct every URL from `https://api.github.com`, cap the
  streamed body before JSON parsing, and expose only typed operations. This is central to the SSRF
  boundary and would still be required around Octokit.
- Pagination, ETag handling, rate-limit headers, and bounded retry behavior are modest when kept in
  one adapter and are easier to audit when they share the feature's request/page/rate/byte budgets.
- Native fetch adds no production dependency. Node documents global
  [`fetch`](https://nodejs.org/download/release/latest-v24.x/docs/api/globals.html#fetch),
  [`AbortSignal.timeout`](https://nodejs.org/download/release/latest-v24.x/docs/api/globals.html#static-method-abortsignaltimeoutdelay),
  and `AbortSignal.any` in the supported runtime.

**Alternatives considered**:

- `octokit`: its retry and throttling plugins are useful, but the package also includes App, OAuth,
  GraphQL pagination, and webhook capabilities outside this feature. Its official dependency set is
  documented in the [Octokit repository](https://github.com/octokit/octokit.js).
- `@octokit/rest`: smaller than the all-in-one package and offers generated methods and pagination,
  but retry/throttling are separate plugins and the feature would still need a guarded custom fetch,
  streamed caps, fixed-origin validation, and shared budget accounting. See the
  [`@octokit/rest` repository](https://github.com/octokit/rest.js).
- `@octokit/request`: exposes headers and abort support, but leaves pagination, retries, throttling,
  host policy, and byte limits to SkillWire, so it does not reduce the security-sensitive code.

**Revisit trigger**: If implementation evidence shows the bounded native adapter becoming larger or
less testable than a narrowly composed Octokit core, evaluate `@octokit/core` plus only pagination,
retry, and throttling plugins. The fixed origin, manual redirects, byte caps, global deadlines, and
PostgreSQL scheduling requirements would remain unchanged.

## Decision 2: Fixed GitHub REST Object Flow

**Decision**: Pin GitHub REST API version `2026-03-10` in one constant and use only server-built
requests to the official `https://api.github.com` origin. Set `redirect: "manual"`. Reject every 3xx
except one repository-metadata `301` whose `Location` is HTTPS on exact `api.github.com`, matches the
allowlisted `/repos/{owner}/{repository}` shape, contains two newly validated components, and has no
unexpected query/fragment. Reconstruct that one request internally; never pass `Location` to fetch.
Discovery hints never supply a fetch target.

**Rationale**:

1. Search `/search/code` for configured recognized evidence. Treat results as mutable hints only.
2. Read `/repos/{owner}/{repository}` to require a public repository and capture the stable numeric
   GitHub repository ID, canonical coordinates, and default branch.
3. Resolve `/repos/{owner}/{repository}/git/ref/heads/{defaultBranch}` once and require an exact
   lowercase 40-character commit SHA.
4. Read `/git/commits/{commitSha}` for the exact tree SHA.
5. Enumerate `/git/trees/{treeSha}?recursive=1`; reject `truncated: true`, unsupported modes,
   ambiguous paths, or any configured limit overrun.
6. Read only selected `/git/blobs/{blobSha}` entries listed by that tree. Require the response SHA,
   decoded size, encoding, and expected tree object to match before validation.
7. Use `/license?ref={commitSha}` only as corroborating license metadata. The actual license and
   notice bodies come from regular blobs in the pinned tree.

GitHub documents the [Git references](https://docs.github.com/en/rest/git/refs#get-a-reference),
[commit objects](https://docs.github.com/en/rest/git/commits#get-a-commit-object),
[trees](https://docs.github.com/en/rest/git/trees#get-a-tree), and
[blobs](https://docs.github.com/en/rest/git/blobs#get-a-blob) separately. Passing immutable SHAs
between these operations prevents a moving branch from redefining the acquired snapshot.

**Alternatives considered**:

- Contents and `download_url` endpoints: rejected because response URLs create an unnecessary target
  surface and are not the strongest object-identity boundary.
- Git clone or archive download: rejected because it broadens bytes, filesystem behavior, object
  types, and execution risk and conflicts with the retrieval-only specification.
- Automatic/general redirect following: rejected. The narrowly validated one-hop repository rename
  is required to preserve idempotence after GitHub rename/transfer; loops, multiple hops, object/blob
  redirects, alternate origins, and malformed locations fail closed.

## Decision 3: Deterministic Pagination, ETags, Rate Limits, and Retries

**Decision**: Iterate pages within explicit run budgets, validate any `Link` target against the same
official origin and allowlisted endpoint, and stop on the configured page/result ceiling. Persist
ETag plus a validated response for mutable discovery/repository metadata; a 304 without the matching
validated body is an error. Never use an ETag or branch cache as revision identity.

Retry only idempotent GETs. Network errors, selected 5xx responses, and 429 are eligible within the
attempt, request, rate, and wall-clock budgets. Honor `Retry-After`; when primary remaining is zero,
honor `X-RateLimit-Reset`; otherwise use bounded exponential backoff with jitter. Ordinary
400/401/403/404/409/422 responses, validation failures, and redirects are not retried. GitHub's
[rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
provide the header semantics.

**Rationale**: A single budget ledger makes search incompleteness, rate exhaustion, retries, and
cancellation deterministic and prevents a malicious or unexpectedly large repository from turning
one job into unbounded work.

**Alternatives considered**: Blindly follow `Link`, retry every failure, or rely only on GitHub's
primary rate limit. Each would weaken endpoint allowlisting or secondary-limit handling.

## Decision 4: Use Constrained YAML and an MDAST Link Parser

**Decision**: Add `yaml` and `mdast-util-from-markdown` as the only parsing dependencies.

- Split bounded `---` frontmatter from the Markdown body before parsing.
- Parse exactly one YAML 1.2 document with a failsafe schema, strict/string-only keys, duplicate-key
  rejection, and zero aliases. Reject anchors, aliases, custom tags, merge keys, directives,
  prototype keys, excessive depth/count, warnings, and parser errors before converting to a strict
  Zod shape. `disable-model-invocation` must be an actual boolean.
- Parse the Markdown body to MDAST and inspect only explicit link and recognized definition nodes.
  Do not treat prose, code, HTML, images, remote/data/root-relative URLs, fragments, queries, or
  generated text as resource declarations. The YAML package documents strict, unique-key,
  failsafe-schema, and alias-count options in its [options reference](https://eemeli.org/yaml/), and
  MDAST defines explicit [link node types](https://github.com/syntax-tree/mdast).

**Rationale**: Direct parsing preserves the original instructions while giving resource discovery a
syntax-level boundary. A regex Markdown scanner cannot reliably distinguish links from code or HTML;
a full unified/remark processing pipeline adds transformations the service does not need.

**Alternatives considered**:

- Handwritten YAML parsing: rejected because quoting, block values, and type semantics are security
  sensitive.
- `gray-matter`: convenient frontmatter extraction, but the design still needs precise YAML parser
  controls and strict schema validation.
- Full `remark`/`unified`: rejected as unnecessary when no plugins or document transformations run.

## Decision 5: PostgreSQL Leases with Fencing Tokens

**Decision**: Coordinate discovery and per-source synchronization with persistent lease rows, not
session advisory locks or a separate queue. Acquisition uses atomic `INSERT ... ON CONFLICT DO
UPDATE ... WHERE lease_expires_at <= clock_timestamp() RETURNING`, increments a monotonic fencing
token, and records a random holder ID. Renewal/release require the exact holder and token.

Every side-effecting terminal transaction locks the lease row `FOR UPDATE`, requires a matching
unexpired holder/token and active cancellation signal, and holds that lock through commit. GitHub
requests never hold a database transaction or connection. PostgreSQL documents atomic conflict
updates in [`INSERT`](https://www.postgresql.org/docs/current/sql-insert.html), row locking in
[explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html), and advancing wall
time in [`clock_timestamp()`](https://www.postgresql.org/docs/current/functions-datetime.html).

**Rationale**: Expiry alone does not prevent a paused worker from committing after a replacement.
The fencing check and row lock prevent that late publication while retaining crash recovery and
multi-instance coordination.

**Alternatives considered**:

- PostgreSQL advisory locks: useful for short migration serialization but tied to a database
  session, not renewable/fenced long-running network work.
- Redis/queue worker: explicitly out of scope and unnecessary for the bounded in-process scheduler.
- An in-memory mutex: does not coordinate multiple containers or survive restart.

## Decision 6: Keep Feature 001 Separate and Add an Asynchronous Unified Provider

**Decision**: Preserve the version-controlled Feature 001 provider, canonical revision v1,
publisher, verifier, and advisory chain unchanged. Add a PostgreSQL imported provider and make a
unified asynchronous catalog port that awaits both providers. The static provider is adapted with
resolved promises; MCP names and old payloads remain valid.

**Rationale**: PostgreSQL is the authoritative import store and supports multi-instance updates.
Making the application port asynchronous permits direct, cancellation-aware database reads instead
of an uncoordinated process cache. Existing first-party data keeps its independently verified
release semantics.

**Alternatives considered**:

- Move Feature 001 into PostgreSQL: rejected as an unnecessary migration and provenance risk.
- Refresh a complete imported in-memory snapshot: possible later as an immutable hash-keyed
  optimization, but direct reads are simpler and avoid cross-instance staleness initially.
- Call GitHub from load/resource: rejected; PostgreSQL already contains verified immutable bundles
  and upstream availability must not affect agent requests.

## Decision 7: Canonical External Revision Schema v2

**Decision**: Add a separate canonical schema v2 for external revisions. Do not alter v1 bytes.
Schema v2 includes stable skill identity, first publication source and exact commit, source path,
instructions, invocation mode, SPDX license and attribution evidence hashes, dependency edges,
resource metadata/bodies, immutable `trustAtPublication`, and complete bundle SHA-256.

A separate content-identity SHA-256 covers the same immutable skill data but excludes the observation
commit. A later snapshot with the same content identity reuses the existing revision and records an
equality observation; the existing revision continues to identify the exact first commit that
published it. Changed content or immutable metadata creates a new revision.

**Rationale**: Including every newly observed commit in content identity would create a revision for
an unrelated upstream change, contradicting deduplication. Excluding provenance from the published
bundle would weaken reproducibility. Two explicitly named hashes satisfy both requirements.

**Alternatives considered**: Modify schema v1, use mutable revision pointers, or derive identity from
Git blob SHA alone. All would either break Feature 001 or omit required license/dependency/provenance
facts.

## Decision 8: Exact-Pinned License Evidence and Conservative Dependencies

**Decision**: Identify a repository license from allowlisted SPDX-compatible evidence in the pinned
tree, corroborate with GitHub's license response at the same commit when available, retain the exact
license/notice content hashes and attribution, and quarantine missing, unsupported, or conflicting
evidence. Never fetch a license URL from content.

Resolve dependencies only from recognized metadata or explicit invocation syntax outside code/HTML
when the exact name maps to one skill in the same snapshot. Store evidence kind, source content hash,
and bounded location, not source excerpts. Required missing, ambiguous, self, or cyclic edges
quarantine the affected dependency graph.

**Rationale**: SPDX metadata alone does not prove the redistributed text is licensed, while fuzzy
dependency inference can silently connect an unrelated skill or repository.

**Alternatives considered**: Trust the mutable repository license field, guess a license, fuzzy-match
names, or fetch missing dependencies elsewhere. Each conflicts with immutable same-source
provenance.

## Decision 9: Deterministic Required Fixtures, Optional Live Smoke

**Decision**: Required CI replays recorded schemas and bodies for
`mattpocock/skills@84fdeffd12f2ee307994d1eb6feb48173b6e0502` while requests still target the
fixed official API origin through an injected fetch. A route manifest hashes every response fixture
and rejects missing, extra, or reordered acquisition. Expected inventory separately asserts 25
manifest skills, MIT attribution, 14 user-only skills, safe textual resources, and exactly the
`grill-with-docs` dependencies on `grilling` and `domain-modeling`.

A manual nonblocking smoke test requires `GITHUB_TOKEN`, reads only that pinned public commit into a
disposable database, and never replaces the recorded CI gate.

**Rationale**: Recorded fixtures are deterministic, rate-limit independent, and support adversarial
mutation. A live test is useful operational evidence but cannot be a reliable required gate.

**Alternatives considered**: Live GitHub in every CI run, mocked domain objects below the REST
adapter, or checking fixture files without a route manifest. Each misses either determinism or the
real request/response boundary.
