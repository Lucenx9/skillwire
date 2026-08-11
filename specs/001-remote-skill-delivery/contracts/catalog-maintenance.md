# Catalog Administration Contract

Catalog administration is offline and outside the six MCP tools. `src/catalog/admin-cli.ts` exposes
exactly two subcommands and no interactive repair or runtime administration mode.

## Package Commands

```json
{
  "catalog:publish": "tsx src/catalog/admin-cli.ts publish",
  "catalog:verify": "tsx src/catalog/admin-cli.ts verify"
}
```

`tsx` is a development dependency. Both commands write one JSON document to stdout, bounded
diagnostics to stderr, and use exit code `0` only for a successful result.

## Required Input Order

1. Exact ten-entry inventory.
2. Ten `SKILL.md` files and declared resources.
3. Ten complete `provenance.json` records.
4. Independently reviewed canonical/hash fixtures.
5. Complete bundle construction and resource hashes.
6. Proposed advisory state and release arguments.
7. Atomic create-only publication.
8. Separate read-only verification.

## `publish`

### Invocation

Genesis:

```bash
pnpm catalog:publish -- --release-id launch-catalog-v1 --genesis
```

Later release:

```bash
pnpm catalog:publish -- \
  --release-id <release-id> \
  --previous-release-commit <40-lowercase-hex-sha>
```

Exactly one of `--genesis` or `--previous-release-commit` is required. Repository paths, inventory
location, and source locations are fixed server-maintainer configuration, not arbitrary CLI fetch
targets.

### Preconditions

- Inventory contains exactly the ten launch identifiers and required metadata.
- Every source bundle has one Markdown instruction document and one declared textual resource.
- Provenance is complete before canonicalization.
- All paths, text, schemas, and sizes are valid.
- No proposed `(skillId, revision)` appears in an existing published batch.
- `catalog/releases/<release-id>/` does not exist.
- Genesis has no earlier local release/advisory history; a later release uses the required SHA.

### Atomicity

After validating the complete proposed batch in memory, the publisher atomically creates the
exclusive `catalog/releases/.publish-claim` directory. If it already exists, all ten results are
rejected with `PUBLICATION_CLAIMED`; the command never guesses that a claim is stale or removes it.
While holding the claim, the publisher rescans every published revision identity and the final
release path, writes all ten records and `release.json` to a sibling staging directory, closes and
syncs every file, syncs the staging directory, and makes the complete batch visible with one
same-filesystem rename to the absent final directory.

- Any validation/staging failure leaves no final release directory.
- The claim covers duplicate scanning through the final rename, so supported concurrent publishers
  cannot pass the same absence check.
- Existing release paths and revision identities are rejected, never overwritten.
- The source inventory, instructions, resources, provenance, advisories, and database are never
  modified.
- Cleanup of an unexposed staging directory is allowed after failure; it is not published state.
- Claim cleanup happens only after the attempt is complete. A crash-left claim blocks later
  publication until an operator proves no publisher remains and removes that exact claim outside
  either catalog subcommand.
- Once the final rename succeeds, the batch is created even if claim cleanup fails. The command
  returns the truthful ten-revision created result, emits bounded `PUBLICATION_CLAIM_REMAINS`
  diagnostics, and later publication stays blocked until safe operator cleanup.

### Output

Success and rejection both conform to `schemas/catalog-publish.output.schema.json` and contain:

- the validated `releaseId`, or `null` when the supplied release identifier itself is invalid
- the overall `created` result
- the final relative `releasePath` on success or `null` on rejection
- exactly ten sorted revision results with skill ID, proposed revision when valid, computed bundle
  SHA-256 and record path when available, `created` or `rejected` status, and a bounded result code
- a bounded overall error-code list

If `created` is true, every revision result is `created` and no errors are present. If any revision
is rejected, `created` is false, no final release path is returned, all ten entries are reported as
`rejected`, and no final batch exists.

### Failure

Exit nonzero with a bounded code such as `INVALID_INPUT`, `PUBLICATION_CLAIMED`, `DUPLICATE_REVISION`,
`RELEASE_ALREADY_EXISTS`, `HASH_MISMATCH`, or `PUBLICATION_FAILED`. No final batch is visible. When
an individual source field is malformed, the result still identifies its inventory skill entry and
uses `null` for a revision, hash, or path that could not be safely derived. Results never include
content.

## `verify`

### Invocation

```bash
pnpm catalog:verify -- --release-id launch-catalog-v1
```

CI supplies `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and `GITHUB_API_URL` and requires GitHub baseline
verification. There is no previous-ref, branch, merge-base, or fallback flag.

### Read-only checks

- Exact inventory and source/provenance schemas.
- Canonical normalized instructions and resources.
- Every resource SHA-256 and complete revision bundle SHA-256.
- Exactly ten per-revision publication records and their release summary.
- Advisory sequences, links, hashes, revision bindings, terminal revocation, and chain head.
- Genesis or non-genesis release metadata rules.
- GitHub previous-release baseline in CI.
- Absence of the publication claim; its presence returns invalid without removing it.

The verifier has no repair option, catalog writer import, PostgreSQL import, migration path, or
filesystem write capability. It may make authenticated read-only GitHub API requests in CI.

### GitHub baseline algorithm

For non-genesis:

1. Fully paginate `GET /repos/{owner}/{repo}/releases?per_page=100`, retain entries with
   `draft: false` and valid `published_at`, including prereleases, and select the unique greatest
   publication timestamp. Incomplete pagination or a timestamp tie fails closed.
2. Resolve the selected release's exact `tag_name` with
   `GET /repos/{owner}/{repo}/git/ref/tags/{tag}`.
3. If the object is a tag, recursively call `GET /repos/{owner}/{repo}/git/tags/{sha}` until the
   terminal object is a commit; reject cycles and other terminal types.
4. Require the commit SHA to be exactly 40 lowercase hexadecimal characters and equal
   `previousReleaseCommit`.
5. Fetch the global `catalog/advisories.jsonl` through the Contents API with
   `ref=<exact-commit-sha>`. Candidate release metadata is validated locally; no prior
   release-directory path is inferred.
6. Require the prior chain to be an unchanged byte prefix and validate the proposed tail/head.

Any unavailable/incomplete release listing, unresolvable selection, tag, commit, candidate metadata,
or chain fails closed. `target_commitish`, merge bases, branches, and local fallbacks are prohibited.

For genesis, CI successfully accesses the repository and the same fully paginated release list
contains no non-draft release, including no prerelease. The local verifier proves there is no earlier
published batch and the candidate chain is initial. A 404 or API failure is not accepted as proof
that the release list is empty.

### Output

Conforms to `schemas/catalog-verify.output.schema.json`. Success contains `valid: true`, release,
inventory, publication-claim, advisory, GitHub-baseline results, selected GitHub release ID and
publication time, resolved commit, and exactly ten sorted per-revision results. The selected-release
fields are null for genesis. Invalid state exits nonzero with `valid: false`; it never changes a file
or database row.

## Command Contract Tests

`catalog-publish.test.ts` runs the real command against isolated catalog fixtures and proves complete
batch visibility, duplicate rejection, per-revision traceability, fail-closed stale claims, exactly
one winner under concurrent publication, truthful success with a simulated claim-cleanup failure,
and no partial release after each pre-rename failure point.

`catalog-verify.test.ts` runs the real command with filesystem-write APIs denied, no database
available, and parameterized GitHub fixtures for genesis, lightweight tag, annotated tag, absent
release, invalid SHA, unavailable prior content, prefix mutation, insertion, deletion, and reorder.
Filesystem snapshots and database probes remain identical before and after every result.
