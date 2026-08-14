# Administrator CLI Contract

## Boundary and Entrypoint

Package script:

```text
pnpm source:admin -- <command> [strict flags]
```

Entrypoint: `src/ingestion/admin-cli.ts`.

This module may import source/application/PostgreSQL writer modules. Existing `catalog:verify` stays a
separate read-only executable/module graph and must not import `admin-cli`, source writers, scheduler,
or PostgreSQL ingestion stores. No command is exposed through MCP or HTTP.

The CLI requires `DATABASE_URL`, a bounded `SKILLWIRE_ADMIN_ACTOR_ID`, and valid ingestion
configuration. GitHub tokens come only from the environment. Flags never accept a token, URL, host,
branch, tag, commit, path, individual skill, content, or license text.

Every invocation writes one bounded JSON object to stdout. Errors use one bounded JSON object with a
stable `errorCode` and exit nonzero; stderr contains no untrusted values.

## Commands

### `source:add`

```text
pnpm source:admin -- source:add --owner <component> --repository <component>
```

- Validates conservative ASCII GitHub components.
- Resolves public repository metadata through the fixed provider, deduplicates by numeric repository
  ID, creates the registration once, and queues an asynchronous registration sync.
- Repeated/case/alias/rename coordinates for the same numeric ID return the same source and active or
  new idempotent run.

Success:

```json
{
  "ok": true,
  "command": "source:add",
  "sourceId": "uuid",
  "created": true,
  "syncRunId": "uuid",
  "syncState": "queued"
}
```

No output contains a token, raw GitHub response, URL, or repository content.

### `discover`

```text
pnpm source:admin -- discover
```

Queues one bounded asynchronous discovery run using configured queries/budgets. If a queued/running
run exists, returns it with `created: false`.

```json
{
  "ok": true,
  "command": "discover",
  "runId": "uuid",
  "created": true,
  "state": "queued"
}
```

### `sync`

```text
pnpm source:admin -- sync --source-id <uuid>
```

Queues a full repository synchronization. It does not accept a skill, ref, commit, URL, or override
the registered default-branch policy. Repeated requests return the active run or an idempotent new
run according to schedule state.

```json
{
  "ok": true,
  "command": "sync",
  "sourceId": "uuid",
  "runId": "uuid",
  "created": true,
  "state": "queued"
}
```

### `list`

```text
pnpm source:admin -- list [--source-id <uuid>] [--state <allowed>] [--cursor <opaque>] [--limit <1..100>]
```

Strictly reads bounded administrative projections. Rows expose opaque IDs, safe coordinates,
classification, stable reason codes, counts, exact published commit when applicable, and timestamps;
they never expose contents, tokens, discovery query text, validation excerpts, or raw remote data.

```json
{
  "ok": true,
  "command": "list",
  "items": [],
  "nextCursor": null
}
```

### `quarantine`

```text
pnpm source:admin -- quarantine --candidate-id <uuid> --reason-code ADMIN_QUARANTINE
```

Appends an attributable classification event and updates the current projection transactionally.
Repeated application is idempotent. It never changes or deletes an immutable revision.

```json
{
  "ok": true,
  "command": "quarantine",
  "candidateId": "uuid",
  "classification": "quarantined",
  "changed": true
}
```

### `verify`

```text
pnpm source:admin -- verify --candidate-id <uuid>
```

Queues deterministic revalidation against the candidate's exact already acquired snapshot/policy
input or, when reacquisition is required, queues the owning source sync. It never accepts replacement
content or another source. Passing validation transitions quarantined/discovered to verified, not
curated.

```json
{
  "ok": true,
  "command": "verify",
  "candidateId": "uuid",
  "runId": "uuid",
  "state": "queued"
}
```

### `curate`

```text
pnpm source:admin -- curate --candidate-id <uuid>
```

Promotes only an exact currently verified candidate/revision. It appends an attributable curation
decision and classification event. Repeating the same decision is idempotent; automation cannot call
the underlying transition.

```json
{
  "ok": true,
  "command": "curate",
  "candidateId": "uuid",
  "classification": "curated",
  "changed": true
}
```

## Stable CLI Errors

`INVALID_INPUT`, `INVALID_CONFIGURATION`, `ADMIN_UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT`,
`LEASE_HELD`, `NOT_VERIFIED`, `CANCELLED`, `GITHUB_UNAVAILABLE`, `RATE_LIMITED`, and `INTERNAL`.

Errors never echo rejected input. Unknown flags, missing values, repeated flags, URL-shaped
coordinates, individual-skill attempts, mutable refs, and extra positional arguments are
`INVALID_INPUT` before network/database writes.

## Required Contract Tests

- Every command's exact grammar, JSON shape, exit status, and bounded output.
- Unknown/duplicate/missing flags and prohibited URL/host/ref/commit/skill/content inputs.
- Missing/revoked operator authority, missing configuration, cancellation, and held lease.
- Repeated add/sync/quarantine/curate idempotence and curate-before-verify rejection.
- Redaction of tokens, coordinates, paths, commits, content, response bodies, and nested errors.
- Dependency graph test proving `catalog:verify` imports no ingestion writer, scheduler, admin CLI, or
  database module and performs no write/network action.
