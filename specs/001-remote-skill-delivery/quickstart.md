# Quickstart and End-to-End Validation

This guide validates the planned MVP. It does not install skills or dependencies on an MCP client.
All project dependencies remain inside the SkillWire development/service environment.

## Prerequisites

- Node.js 24
- pnpm matching `packageManager`
- Docker with Compose
- GitHub token with `contents: read` for catalog release-baseline verification
- Access to the repository named by `GITHUB_REPOSITORY`

## Install and Static Checks

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: strict TypeScript and type-aware ESLint pass. `package.json` includes `tsx` as a
development dependency and exactly these catalog scripts:

```text
catalog:publish -> tsx src/catalog/admin-cli.ts publish
catalog:verify  -> tsx src/catalog/admin-cli.ts verify
```

## Validate Immutable Inputs First

```bash
pnpm vitest --project unit tests/unit/evaluation/fixture-validation.test.ts
```

Expected: exact inventory, all ten source/provenance bundles, canonical vectors, GitHub/advisory
fixtures, the >=30-case search corpus, and the >=20-case journey matrix are valid before evaluated
behavior runs.

## Catalog Administration Contracts

Run both real-command contract suites against isolated fixture directories:

```bash
pnpm vitest --project contract tests/contract/catalog-cli/catalog-publish.test.ts
pnpm vitest --project contract tests/contract/catalog-cli/catalog-verify.test.ts
```

Expected publication evidence:

- one atomic release directory appears only after all ten revision records are complete;
- structured output reports every revision;
- duplicate release/revision attempts fail without overwrite;
- concurrent attempts produce one winner, while an existing/stale publication claim fails closed;
- injected failures expose no partial batch.

Expected verification evidence:

- inventory, provenance, bundles, resource hashes, advisory chain, and release metadata validate;
- the command performs no filesystem or database write on success or failure;
- drift fails without repair.

## Verify the Published Catalog Against GitHub

```bash
export GITHUB_REPOSITORY='OWNER/REPOSITORY'
export GITHUB_TOKEN_FILE='/run/secrets/skillwire_github_token'
export GITHUB_TOKEN="$(< "$GITHUB_TOKEN_FILE")"
pnpm catalog:verify -- --release-id launch-catalog-v1
unset GITHUB_TOKEN
```

Expected for genesis: GitHub is reachable, its release list is fully paginated, no non-draft release
(including a prerelease) exists, no earlier local published batch exists, the candidate advisory
chain is initial, and release metadata explicitly identifies genesis.

Expected for later releases: the fully paginated release list selects the unique latest
`draft: false` release by `published_at`, including a published prerelease. Its tag resolves to an
exact 40-character commit equal to `previousReleaseCommit`; the previous chain is fetched at that
exact commit and is an unchanged prefix. Missing/unavailable/ambiguous state fails closed. No merge
base, branch, `target_commitish`, or fallback is used.

The production launch batch is normally committed already. To exercise creation manually, use only
an isolated catalog fixture:

```bash
pnpm catalog:publish -- --release-id launch-catalog-v1 --genesis
```

Re-running against the same fixture must reject the existing release and revision identities.

## Start the Service

```bash
docker compose up --build --wait
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

Expected: readiness remains false until migrations, catalog verification, PostgreSQL connectivity,
and startup expired-audit cleanup complete. Compose runs one service instance for local convenience;
the architecture does not rely on a single instance.

## Progressive MCP Journey

```bash
pnpm smoke:mcp -- \
  --endpoint http://127.0.0.1:3000/mcp \
  --api-key-file /run/secrets/skillwire_api_key \
  --task 'Review strict TypeScript changes and identify unsafe narrowing'
```

Expected:

1. `search_skills` returns previews only, including `trustAtPublication` and
   `currentAdvisoryStatus`.
2. `load_skill` returns exact instructions, immutable provenance, bundle hash, and manifest without
   resource bodies.
3. `read_skill_resource` returns one declared verified text resource.
4. No skill, package, script, resource, or dependency is created on the client.

## PostgreSQL-Only Repository Memory

Run the memory end-to-end suite:

```bash
pnpm vitest --project e2e tests/e2e/repository-memory.test.ts
pnpm vitest --project integration tests/integration/postgres/repository-memory-store.test.ts
```

Expected: load, ranking projection, list, outcome, and forget operations query the authoritative
database directly. The implementation contains no repository-memory cache interface/module,
invalidation step, scope lock, or secondary authority. Account/repository isolation and restart
persistence pass.

## Erasure and Audit Expiration

```bash
pnpm vitest --project e2e tests/e2e/outcomes-and-erasure.test.ts
pnpm vitest --project integration tests/integration/postgres/repository-erasure.test.ts
pnpm vitest --project integration tests/integration/postgres/erasure-audit-expiration.test.ts
pnpm vitest --project integration tests/integration/service/audit-cleanup-readiness.test.ts
```

Expected:

- forget deletes tenant-scoped usage and inserts the six-field audit row in one transaction;
- output remains `{ "forgotten": true }` for present and empty scopes;
- every audit query excludes rows at/after exact 30-day expiration;
- with continuous service/database availability, hourly cleanup deletes within one hour;
- after simulated downtime, readiness remains false until startup cleanup succeeds;
- no physical-deletion guarantee is asserted while PostgreSQL is unavailable.

## Security and No-Client-Write Validation

```bash
pnpm vitest --project security
pnpm vitest --project e2e tests/e2e/no-client-write.test.ts
```

Expected: authentication, tenant isolation, GitHub baseline failures, SSRF inputs, traversal,
binary/oversized content, execution attempts, and client filesystem snapshots all pass their
dedicated responsibility without duplicate matrices.

## Complete Release Readiness

```bash
pnpm test:unit
pnpm test:contract
pnpm test:evaluation
pnpm test:integration
pnpm test:e2e
pnpm test:security
pnpm catalog:verify -- --release-id launch-catalog-v1
docker compose -f compose.yaml -f compose.test.yaml config --quiet
docker build .
```

User Story 1 alone is only the first vertical slice. Release readiness requires all five stories,
all six tools, both evaluation thresholds, all security/privacy evidence, and applicable checks
above.

## Optional Informational Benchmark

```bash
docker compose -f compose.yaml -f compose.benchmark.yaml up --build --wait
pnpm benchmark:informational
```

Expected: report metadata and raw-result hash validate. Observed timings are evidence only and do not
change release status.
