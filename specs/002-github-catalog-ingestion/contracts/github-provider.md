# GitHub Provider Contract

## Purpose

The application sees typed source discovery and immutable object-reader ports. It never handles an
arbitrary URL, follows response URLs, or depends on Octokit types.

Production uses exactly `https://api.github.com` and REST API version `2026-03-10`. Test fixtures may
inject the fetch function but still assert requests target that exact origin. The base URL is not
configurable. Fetch redirect mode is manual; only the repository-metadata operation may reconstruct
one validated same-origin GitHub rename hop.

## Typed Inputs

```text
GitHubRepositoryCoordinate { owner, repository }
GitCommitSha                40 lowercase hexadecimal characters
GitObjectSha                40 lowercase hexadecimal characters
GitHubOperationContext      { signal, absoluteDeadline, budgetLedger, optional validated ETag cache }
```

Owner/repository are validated single ASCII components before encoding. Object methods accept only
validated SHA values. No method accepts a URL, host, scheme, path to fetch, raw Link/Location value,
or content-derived identifier.

## Application Port

```text
discoverRecognizedRepositories(querySetId, context)
  -> paged discovery hints with evidence kind and coordinates

resolvePublicRepository(coordinate, context)
  -> numeric repository ID, canonical coordinate, default branch, public visibility, ETag identity

resolveDefaultBranch(repositoryIdentity, context)
  -> exact commit SHA

readCommit(repositoryIdentity, exactCommitSha, context)
  -> same exact commit SHA and exact tree SHA

readRecursiveTree(repositoryIdentity, exactTreeSha, context)
  -> complete non-truncated bounded tree of typed entries

readBlob(repositoryIdentity, exactBlobSha, expectedSize, context)
  -> exact SHA, strict bytes, decoded size

readLicenseMetadata(repositoryIdentity, exactCommitSha, context)
  -> optional corroborating SPDX metadata only
```

The source synchronization service calls them in this order. Tree/blob calls are impossible until a
repository's public numeric identity and exact commit/tree have been validated.

## HTTP Mapping

| Operation | Method and allowlisted endpoint |
| --- | --- |
| Discovery | `GET /search/code` with server-controlled query/page/per-page |
| Repository | `GET /repos/{owner}/{repository}` |
| Default ref | `GET /repos/{owner}/{repository}/git/ref/heads/{encoded-default-branch}` |
| Commit | `GET /repos/{owner}/{repository}/git/commits/{commitSha}` |
| Tree | `GET /repos/{owner}/{repository}/git/trees/{treeSha}?recursive=1` |
| Blob | `GET /repos/{owner}/{repository}/git/blobs/{blobSha}` |
| License corroboration | `GET /repos/{owner}/{repository}/license?ref={commitSha}` |

Every request includes fixed accept/version/user-agent headers and an operator Bearer token when live
acquisition is enabled. All 3xx responses are errors except one repository-metadata `301` whose
`Location` is exact HTTPS `api.github.com`, matches `/repos/{owner}/{repository}`, contains validated
components, and has no unexpected query/fragment. The client rebuilds the request; it never gives the
response URL directly to fetch. A second redirect or numeric repository conflict fails closed.

## Pagination Contract

- Search pages are positive integers generated locally, with `per_page <= 100`.
- The run enforces configured query, page, result, request, rate, response-byte, and absolute-deadline
  budgets before each next page.
- If `Link` is present, parse it only to verify the generated next page: HTTPS, exact
  `api.github.com`, same allowlisted path/query, expected next integer page. Any disagreement fails.
- Stop on no next page, short final page, budget ceiling, or cancellation.
- `incomplete_results: true` makes the discovery run incomplete; it never claims exhaustive results
  or directly quarantines/publishes repository content.

## ETag Contract

- ETags may optimize mutable search/repository metadata and exact immutable object reads.
- Cache key includes API version, method, exact endpoint identity, authorization scope class, and
  request parameters.
- Stored ETag is bound to a previously schema-validated body and body SHA-256.
- A 304 is accepted only with that exact body; otherwise `CACHE_MISS_ON_NOT_MODIFIED` fails closed.
- Mutable branch/ref cache never identifies an imported revision. Every synchronization resolves the
  ref and then uses exact commit/tree/blob IDs.

## Retry and Rate Contract

- Maximum attempts and all sleeps consume the same request/run/deadline budgets.
- Retry only safe GET network errors, selected 5xx, and 429.
- Honor bounded `Retry-After`. When primary remaining is zero, use `X-RateLimit-Reset`; otherwise use
  bounded exponential backoff/jitter for eligible failures.
- Do not retry validation errors, redirects, or ordinary 400/401/403/404/409/422.
- Abort fetch, body streaming, and retry wait when signal/deadline/lease is lost.
- Expose only safe normalized outcomes and numeric rate state to callers; never expose token, raw
  header/body, remote URL, or untrusted error text to logs.

## Response Validation

- Cap the encoded response stream before JSON parsing, independently of `Content-Length`.
- Validate JSON with strict Zod schemas and bounded arrays/strings/numbers.
- Require positive repository ID and public visibility.
- Require exact lowercase object SHA and expected object type at every transition.
- Tree entries require safe normalized path, known type/mode, exact SHA, and bounded size. Reject
  `truncated: true` and all path collisions.
- Blob responses require exact requested/tree SHA, `encoding: "base64"`, valid Base64, declared and
  decoded size equality, and per-object/aggregate caps.
- The provider returns bytes, never writes a repository/archive/file, and never executes anything.

## Provider Error Taxonomy

Safe internal categories:

- `INVALID_SOURCE_IDENTITY`
- `SOURCE_NOT_PUBLIC`
- `REDIRECT_REJECTED`
- `GITHUB_AUTHENTICATION_FAILED`
- `GITHUB_NOT_FOUND`
- `GITHUB_RATE_LIMITED`
- `GITHUB_TRANSIENT`
- `GITHUB_SCHEMA_INVALID`
- `PAGINATION_BUDGET_EXCEEDED`
- `RESPONSE_BUDGET_EXCEEDED`
- `CACHE_MISS_ON_NOT_MODIFIED`
- `COMMIT_MISMATCH`
- `TREE_TRUNCATED`
- `TREE_OVERSIZED`
- `TREE_AMBIGUOUS`
- `OBJECT_UNSUPPORTED`
- `HASH_MISMATCH`
- `CANCELLED`

The policy engine decides whether a deterministic content error is a quarantine finding. Transient,
rate, timeout, and cancellation outcomes do not mutate candidate classification or advisory status.

## Fixture Contract

Required CI provides a fetch implementation backed by a route manifest. Each entry specifies method,
exact official-host path/query, selected safe response headers, status, body fixture path, and fixture
SHA-256. Tests reject unrecorded, missing, repeated beyond expectation, or extra routes and validate
the full acceptance inventory independently. No required test can fall back to live network.
