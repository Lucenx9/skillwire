# Quickstart and End-to-End Validation

This guide describes the runnable interface the implementation must provide. It validates the
finished MVP; it does not contain application implementation code.

## Prerequisites

- Node.js 24 LTS
- Corepack with pnpm 11
- Docker Engine with Docker Compose v2
- `curl` and a JSON formatter

## Local Setup

```bash
corepack enable
pnpm install --frozen-lockfile
docker compose up -d postgres
pnpm db:migrate
pnpm admin account:create --id 00000000-0000-4000-8000-000000000001
pnpm admin api-key:create --account 00000000-0000-4000-8000-000000000001
pnpm dev
```

The key command prints the bearer token once. Store it in a local shell variable and do not place it
in shell history, `.env`, source control, logs, or command output captured by CI. The implemented CLI
must support reading secrets and output destinations safely; production usage is documented in
[deployment.md](./deployment.md).

Expected readiness endpoints:

- `GET /health/live` returns success when the process is running.
- `GET /health/ready` returns success only after catalog verification, migration compatibility, and
  a PostgreSQL readiness check.
- `POST /mcp` is the only MCP endpoint.

## Contract Validation

```bash
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:security
```

Expected result: every command exits zero, generated Zod schemas match `contracts/schemas/`, and the
security suite reports no client filesystem mutation or sensitive log fields.

## MCP Journey

Use an MCP v2 client or inspector configured with:

```text
URL: http://127.0.0.1:3000/mcp
Authorization: Bearer <one-time-issued-token>
Transport: Streamable HTTP, stateless JSON response mode
```

Perform these calls in order using the schemas under [contracts/schemas](./contracts/schemas/):

1. Call `search_skills` with a task and no repository hash.
   - Expect ranked previews only.
   - Confirm no instructions, manifest, or resource content is present.
2. Call `load_skill` for the exact skill ID and revision from one preview, still without a hash.
   - Expect instructions, source, trust status, revision hash, and manifest.
   - Confirm `memoryRecorded` is false.
3. Call `read_skill_resource` for one declared path.
   - Expect only that resource and its SHA-256.
4. Call `list_repo_memory` using a valid repository hash.
   - Expect an empty list because the earlier load was hashless.
5. Repeat `load_skill` with that repository hash.
   - Expect `memoryRecorded` true and a usage row on the next list.
6. Record `useful`, list memory, then search with the same hash.
   - Expect the stored outcome and only the bounded secondary ranking boost.
7. Call `forget_repo_memory`, restart SkillWire, then list again.
   - Expect an empty list; repeated forget also succeeds.

## Isolation Validation

Create a second account/key through the operator CLI. Use the same repository hash for both keys:

1. Load and mark a skill useful under account A.
2. List and search under account B.
3. Verify B sees no A usage or ranking boost.
4. Forget under B and verify A remains unchanged.
5. Revoke A's key and verify its next call returns HTTP 401 while B remains valid.

## Integrity and Failure Validation

Run the named fixtures through the security suite rather than editing the launch catalog:

```bash
pnpm test:security -- --runInBand
```

The suite must prove rejection of traversal, symlinks, arbitrary URL fields, oversized content,
unknown/floating revisions, bundle/resource hash mismatches, cache corruption, cross-account
access, revoked keys, and executable-looking skill text. Expected failures expose stable safe codes
and a request ID, never local paths, source details, secrets, or protected content.

## Full Compose Validation

```bash
docker compose up --build --wait
docker compose run --rm skillwire pnpm test:e2e
docker compose restart skillwire
docker compose run --rm skillwire pnpm test:integration -- persistence
docker compose down
```

Do not add `--volumes` when validating restart persistence. Use `docker compose down --volumes` only
when deliberately discarding the local PostgreSQL test volume.
