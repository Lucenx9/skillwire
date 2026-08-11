# Catalog publication and verification

Catalog administration is offline. It is never exposed through MCP and never
runs in the serving container's request path.

## Create-only publication

In a trusted maintainer checkout with development dependencies installed:

```bash
pnpm catalog:publish --release-id '<release-id>' --genesis
```

Later releases use `--previous-release-commit <40-lowercase-hex-sha>` instead of
`--genesis`. Publication validates the complete ten-skill batch before acquiring
`catalog/releases/.publish-claim`, rescans immutable revision identities while
holding the claim, writes and syncs a sibling staging directory, and performs
one same-filesystem rename. Existing claims, release paths, or revision
identities fail closed; no published file is overwritten.

## Claim recovery

The CLI deliberately never removes a claim that it did not safely finish. If a
process crashes:

1. Stop all catalog publication processes.
2. Prove no publisher holds or is using the checkout/filesystem.
3. Inspect that no staging directory was renamed to the requested final release.
4. Remove only the exact stale `catalog/releases/.publish-claim` directory using
   the operator's controlled filesystem procedure.
5. Run read-only verification before retrying publication.

Never automate claim age guessing or recursive cleanup of `catalog/releases`.

## Read-only verification

```bash
pnpm catalog:verify --release-id launch-catalog-v1
pnpm advisory:verify --release-id launch-catalog-v1
```

CI adds `--github` to advisory verification with `GITHUB_REPOSITORY`,
`GITHUB_TOKEN`, and `GITHUB_API_URL`. It fully paginates non-draft releases,
resolves the selected tag to an exact commit, and verifies that the current
advisory chain is an unchanged append of bytes retrieved at that commit. Missing
or ambiguous GitHub state fails closed.

Verification has no repair mode and writes neither catalog files nor PostgreSQL
rows. Runtime containers include only the already-published catalog and execute
as a non-root user on a read-only filesystem.
