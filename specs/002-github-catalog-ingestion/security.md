# Security Model: GitHub Catalog Ingestion

## Security Objectives

1. GitHub ingestion cannot become an arbitrary network fetcher.
2. Repository content remains inert untrusted text and is never executed or installed.
3. A moving branch, changed response, path ambiguity, unsupported Git object, or partial acquisition
   cannot enter an immutable published revision.
4. Verification and curation communicate limited, distinct trust claims.
5. Cancellation, deadlines, lease loss, and transaction failure produce no late persistent effect.
6. Existing authentication, tenant isolation, rate limiting, repository memory, advisory handling,
   redaction, and no-client-write guarantees apply to imported skills.

## Trust Boundaries

| Boundary | Untrusted input | Trusted control |
| --- | --- | --- |
| Agent MCP request | Task text, identifiers, invocation context, resource path, repository hash | Strict existing Zod schemas, bearer auth, rate/deadline middleware; no source/network fields |
| Administrator CLI | Command/flags and operator environment | Fixed command grammar, existing database/operator access, server-controlled GitHub credentials |
| GitHub REST | Status, headers, JSON, object graph, Base64 blobs, rate signals | Fixed API origin/version/endpoints, schemas, budgets, exact SHA checks, manual redirects |
| Repository text | Manifest, YAML, Markdown, license, resources, dependency references | Strict bounded parsers, path/object policy, text validation, deterministic quarantine |
| Scheduler concurrency | Duplicate jobs, stale processes, crashes | PostgreSQL lease holder plus monotonic fencing token and final row lock |
| Published catalog | Database rows and caches | Canonical bytes/hashes, create-only constraints, verified provider, advisory/classification joins |

## Network and SSRF Controls

- Production target origin is a compile-time `https://api.github.com` constant. Configuration can
  supply credentials and budgets, not an alternate host or base URL.
- Public API methods accept validated `owner`, `repository`, branch name obtained from validated
  metadata, and lowercase object SHAs. They never accept a URL.
- Owner and repository are single ASCII components with conservative length/character rules. Reject
  slash, backslash, percent, `.`/`..`, control characters, Unicode confusables, URL syntax, query,
  fragment, credentials, ports, and encoded separators before percent encoding.
- Fetch uses `redirect: "manual"`. Every 3xx fails except one repository-metadata `301` to an exact
  HTTPS `api.github.com/repos/{owner}/{repository}` target with two newly validated components and no
  unexpected query/fragment. SkillWire reconstructs that request internally, rejects loops/multiple
  hops, and records the old coordinate as an alias only after the numeric repository ID matches.
  `download_url`, `html_url`, raw URLs, content links, license URLs, and other response-provided
  targets are never requested.
- Pagination uses a server-generated integer next page. If a `Link` header is parsed for
  consistency, its URL must be HTTPS, exact `api.github.com`, and the same allowlisted endpoint and
  configured query before it can agree with the generated page.
- Search results identify candidates only. Metadata/default-ref resolution under the fixed source
  definition is mandatory before tree/blob work.
- A dedicated security test records every attempted request and fails on any host, scheme, method,
  endpoint, or identifier not in the typed route manifest.

## Git Object Integrity

- Require a public repository metadata response and retain its positive numeric repository ID.
- Resolve the mutable default branch exactly once. Require an object of type `commit` with a full
  lowercase 40-character SHA; never use an abbreviated SHA, tag name, branch name, `HEAD`, or search
  result as snapshot identity.
- Require the exact commit response to name the requested commit and a full tree SHA.
- Reject recursive trees with `truncated: true`, over-budget entry/byte counts, duplicate normalized
  paths, NFC/case-fold collisions, parent/child type conflicts, or unexpected entry schemas.
- Only mode `100644`, type `blob` is eligible for manifest, instructions, license, notice, or
  resource content. Reject executable `100755`, symlink `120000`, submodule `160000`, tree/directory,
  and unknown objects when selected or declared.
- Fetch selected content only by the tree-listed blob SHA. Require response SHA, declared size,
  Base64 encoding, decoded size, and strict schema to match. Hash normalized bytes before parsing.
- Read streams under encoded and decoded caps; `Content-Length` is an early rejection hint, never the
  sole control. Abort the body stream at the cap.
- Conditional 304 is valid only when the matching request key, ETag, validated response body, and
  body hash are present. Otherwise fail closed.
- A single repository metadata 404/non-public response is transient evidence only. Source-wide
  unavailable advisories require the repeated uncached confirmation window in the operational
  policy and absence of a newly discovered alias for the stable numeric repository ID.

## Path and Resource Safety

- Normalize tree paths once using repository-relative POSIX syntax. Reject absolute/root-relative
  paths, empty segments, `.`/`..`, backslash, NUL/control characters, percent-encoded ambiguity,
  invalid UTF-8, Unicode normalization changes, query/fragment aliases, and excessive lengths/depth.
- Resolve each manifest skill directory and resource from the declaring skill root against the
  already validated pinned tree map. No filesystem path or OS realpath operation is involved.
- The plugin manifest is authoritative when present. Its path must identify one normalized skill
  root containing one regular `SKILL.md`. Duplicate or overlapping declarations are deterministic
  failures.
- Markdown resources come only from recognized relative `.md` or `.txt` link/definition nodes
  outside code, HTML, images, remote/data/root-relative links, and fragments. Ordinary prose does
  not declare a resource.
- A resource must be explicitly declared, remain inside the skill/repository boundary, map to one
  regular tree blob, decode as strict UTF-8 without NUL, satisfy byte/count/bundle limits, and receive
  its own SHA-256.
- Script and executable-looking content such as `wizard/template.sh` may be mentioned in
  instructions but is never placed in a resource manifest or fetched as a resource.

## Parser Safety

### Plugin JSON

- Cap bytes before JSON parsing.
- Require a single object and a strict versioned Zod schema.
- Reject duplicate skill paths after normalization, unknown structural variants, scalar coercion,
  non-string paths, embedded URLs, and unbounded arrays/strings.

### YAML Frontmatter

- Require one bounded frontmatter block and one YAML 1.2 document.
- Use failsafe schema, string keys, duplicate-key rejection, strict parsing, and zero allowed aliases.
- Reject directives, tags, anchors, aliases, merge keys, prototype keys, non-scalar keys, excessive
  nesting/node/key counts, warnings, and parser errors.
- Validate the converted value with strict Zod schemas. `disable-model-invocation` is accepted only
  as the exact boolean `true` or `false`, never a string/coerced value.

### Markdown

- Bound instruction bytes and AST node/depth counts.
- Parse CommonMark to an AST; do not render HTML, resolve imports, run plugins, evaluate expressions,
  or execute code fences.
- Preserve original normalized Markdown instructions. AST inspection only derives explicit resource
  and dependency evidence.

## License, Attribution, and Dependency Policy

- Inspect allowlisted root and skill-level license/notice blobs from the exact tree. A versioned
  SPDX-compatible allowlist governs automatic publication.
- GitHub license metadata at `ref=<commit>` may corroborate but cannot replace the pinned license
  body. Missing, unsupported, or conflicting repository/manifest/skill evidence quarantines.
- Retain exact license/notice hashes and bounded attribution with the revision. Search/load may expose
  the SPDX ID and attribution, never the license body.
- Dependency evidence is recognized metadata or explicit invocation syntax outside code/HTML. It
  must name exactly one skill in the same source snapshot.
- Store evidence kind, source-content hash, and bounded location, not excerpts. Missing required,
  ambiguous, cross-source, self, and cyclic dependencies quarantine; fuzzy prose creates no edge.
- The service never follows dependency links to another repository or network target.

## Trust and Eligibility

- `discovered`: recognized evidence only; not agent-visible.
- `structurally-verified` at publication: immutable statement that the specified automated checks
  passed. It does not mean semantically correct, harmless, high quality, or endorsed.
- Current `verified`: eligible after current automated policy passes.
- Current `curated`: separately attributable administrator promotion of already verified exact
  content.
- Current `quarantined`: not searchable/loadable/readable; has stable administrative reason codes.
- Current advisory status is derived independently. Search excludes unavailable/revoked; exact load
  may serve a verified unavailable PostgreSQL bundle; revoked is non-disclosing not found.
- Reclassification/advisories never alter immutable content, source commit, hashes, license,
  dependencies, or trust at publication.
- Skill deletion is confirmed only by a complete current tree. Whole-source public unavailability is
  recorded with a distinct reason after repeated confirmation and never claims whether the source
  was deleted or made private.

## Deadlines, Cancellation, and Concurrency

- Every GitHub operation receives one absolute run deadline and cancellation signal. Compose caller,
  shutdown, and timeout signals; use the same deadline for fetch, streamed body, retry delay, parsing
  checkpoints, database writes, and lease heartbeats.
- Do not start a request, retry, page, blob read, parser phase, or database transaction after the
  deadline.
- PostgreSQL work uses bounded lock/statement timeouts and checks the signal before every
  side-effecting transaction and immediately before commit.
- Publication locks the exact lease row and validates holder, fencing token, and future expiry. A
  stale process cannot commit after takeover.
- Timeout/cancellation/lease loss rolls back publication and cannot append classifications,
  advisories, run success, or repository-memory usage.
- Agent-request cancellation continues through the asynchronous unified provider and existing
  repository-memory transaction so imported reads introduce no late memory side effect.

## Authentication, Authorization, and Error Posture

- The existing bearer API-key middleware, account isolation, revoked/expired key behavior,
  per-account/key rate limits, deadlines, and MCP error mapping remain unchanged for all six tools.
- Agent tools accept no GitHub source, owner, repository, URL, host, ref, branch, tag, commit, import,
  sync, verify, or curation fields. Strict schemas reject extras before any network or database
  side effect.
- Source administration remains a separate operator CLI using explicit database/operator authority
  and credentials from the environment. It never reuses agent bearer authorization.
- Guessed discovered/quarantined/revoked identities, cross-account memory attempts, invalid resource
  paths, and unknown imported revisions use existing non-disclosing validation/not-found responses.
- GitHub upstream errors appear only in bounded administrator run status/reason codes, never agent
  error detail.

## Logging and Audit Redaction

Extend the existing event allowlist with only:

- event type
- opaque source/run/candidate/revision IDs
- state/classification/reason code
- bounded counters
- retry/rate-limit category
- duration bucket
- fencing token as a non-secret integer when operationally necessary

Never log or audit raw API keys/tokens, Authorization headers, repository-memory hashes, agent
queries/tasks, owner/repository coordinates, commit/blob hashes, local or remote paths, URLs, GitHub
request IDs/headers, manifest/frontmatter, skill/license/resource content, attribution text, or
dependency excerpts. Test both key-name redaction and secret/value detection using adversarial nested
errors. GitHub client errors are mapped to safe internal codes before logging.

## Required Adversarial Coverage

- URL-shaped coordinates, encoded separators, Unicode confusion, DNS/host/redirect attempts, hostile
  Link/Location/download/raw/license URLs, and content-derived network references.
- Malformed/oversized schemas, incomplete search, truncated/oversized/ambiguous trees, unsupported
  modes, duplicate/case/Unicode paths, SHA/size/encoding mismatch, replacement responses, invalid
  Base64/UTF-8/NUL/binary content, and all configured budget boundaries.
- Raw/double-encoded traversal, slash/backslash/absolute/root paths, directory/symlink/submodule/
  executable resources, remote/data/image/code/HTML links, query/fragment aliases, and undeclared
  resources.
- YAML aliases/anchors/tags/merge/prototype/duplicate keys/coercion/depth expansion and Markdown AST
  count/depth overrun.
- License and attribution gaps/conflicts; missing/ambiguous/cyclic/cross-source dependencies.
- Two-worker lease takeover, stale heartbeat, abort during fetch/body/backoff/parse/DB, and failure
  injection at each publication step.
- Search/load/resource eligibility for every classification/advisory/invocation context, repository
  memory relevance before boost, cross-account access, revoked/expired keys, rate limiting, redaction,
  and no client-tree writes on success/failure/retry/cache/quarantine/erasure.
