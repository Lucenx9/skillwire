# Quickstart: Validate GitHub Catalog Ingestion

This guide describes the runnable validation path expected after Feature 002 implementation. It uses
the deterministic recorded GitHub API fixture and a disposable PostgreSQL database; required
validation does not need a GitHub token or live network.

## Prerequisites

- Node.js 24
- pnpm 11.21.0 through Corepack
- Docker with Compose
- A clean checkout on `002-github-catalog-ingestion`

## 1. Install and Start PostgreSQL

```bash
corepack enable
pnpm install --frozen-lockfile
docker compose -f compose.yaml -f compose.test.yaml up -d postgres
```

Export the test `DATABASE_URL` documented by `compose.test.yaml`, then apply all migrations:

```bash
pnpm db:migrate
```

Expected: migrations `001` through `006` are current, with no checksum drift. Repeating the command
is a no-op.

## 2. Run Static and Existing Integrity Gates

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm catalog:verify --release-id launch-catalog-v1
pnpm advisory:verify --release-id launch-catalog-v1
```

Expected: Feature 001 verification remains unchanged and no command imports or writes through the
GitHub ingestion modules.

## 3. Replay the Fixed Acceptance Import

Run the fixture/provider, source CLI contract, and PostgreSQL publication tests:

```bash
pnpm exec vitest run \
  tests/contract/source-cli \
  tests/integration/github-ingestion \
  tests/security/github-ingestion
```

The fixture makes the registered repository's default ref resolve to:

```text
84fdeffd12f2ee307994d1eb6feb48173b6e0502
```

Expected publication evidence:

- one canonical GitHub source/registration and one exact source snapshot;
- `.claude-plugin/plugin.json` version 1.2.3 is authoritative;
- all 25 unique manifest entries are processed without individual registration;
- all published revisions preserve `mattpocock/skills`, Matt Pocock, MIT, exact source paths, and the
  acceptance commit;
- 14 revisions are user-only;
- `grill-with-docs` has exactly the `grilling` and `domain-modeling` dependencies;
- safe Markdown resources are available; scripts such as `wizard/template.sh` are not resources;
- repeating add/sync creates no duplicate source, snapshot, skill, revision, resource, dependency,
  content, finding, classification, or publication identity.

## 4. Prove the MCP Journey

Run the MCP contract and recorded end-to-end acceptance journeys:

```bash
pnpm exec vitest run \
  tests/contract/mcp \
  tests/e2e/github-ingestion.test.ts \
  tests/evaluation/github-import-search.test.ts \
  tests/evaluation/github-import-journeys.test.ts
```

The primary journey performs:

1. `search_skills` with `invocationContext: "user-requested"` for `ask-matt`.
2. `load_skill` with the exact returned imported revision.
3. `read_skill_resource` for `PHASE-BOUNDARIES.md`.

Expected:

- at most three MCP calls;
- search contains preview/provenance/trust/classification/invocation metadata but no instructions,
  resource body, or license body;
- load contains exact instructions, dependencies, hashes, license/attribution, and complete resource
  manifest but no resource body;
- resource read returns exactly the declared hash-verified text;
- automatic or missing context excludes the same user-only skill, even for an exact-name task;
- the client fixture tree is byte-for-byte unchanged before/after;
- no MCP call makes a GitHub request;
- imported search evaluation is at least 90%, all forbidden-visibility cases are 100% excluded, and
  existing Feature 001 thresholds still pass.

## 5. Prove Repository Memory

The E2E suite repeats search/load with a valid account-scoped 64-character repository hash and then:

```text
load_skill(repositoryHash) -> list_repo_memory -> record_skill_outcome -> search_skills(repositoryHash)
```

Expected:

- usage aggregates only for the authenticated account/repository/exact imported revision;
- omitting the repository hash stores nothing;
- useful/neutral/unsuccessful ranking semantics are unchanged;
- a memory boost never makes a zero-relevance skill visible;
- cross-account/cross-repository reads remain isolated;
- erasure is transactional, idempotent, non-disclosing, and leaves the client tree unchanged.

## 6. Run the Complete Required Suite

```bash
pnpm test
git diff --check
```

Then run the existing container validation used by CI for migration-before-readiness, active
PostgreSQL outage/recovery, clean shutdown, and restart persistence.

Expected: every Feature 001 and Feature 002 required test passes; no required test contacted live
GitHub; working-tree changes are only the intended implementation/fixture/documentation changes.

## 7. Optional Live GitHub Smoke

This step is manual and nonblocking. Use a least-privilege token and disposable database:

```bash
GITHUB_TOKEN='<token>' pnpm smoke:github-live
```

Expected: the command addresses only `https://api.github.com`, reads only the fixed public acceptance
repository at the exact pinned commit, validates the recorded inventory, and exits without writing to
GitHub or changing required fixtures. A missing token skips this manual command clearly and does
not affect required CI.

## Cleanup

```bash
docker compose -f compose.yaml -f compose.test.yaml down
```

The database container is disposable. No repository content is installed into the client checkout,
home directory, agent skill directory, or package directory at any point.
