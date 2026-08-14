# MCP Contract Extensions

## Compatibility Rule

SkillWire continues to expose exactly the existing six MCP tools:

1. `search_skills`
2. `load_skill`
3. `read_skill_resource`
4. `list_repo_memory`
5. `record_skill_outcome`
6. `forget_repo_memory`

No discovery, registration, GitHub, synchronization, verification, or curation tool is added to MCP.
Every Feature 001 request remains valid, and a Feature 001 result retains its existing shape and
field values. Imported results use additive external-only fields selected by a discriminator. Memory
tool contracts are unchanged.

All schemas remain strict. Unknown fields—including URL, host, owner, repository, branch, tag,
commit, path-to-fetch, token, import, and synchronization fields—produce the existing invalid-request
response before network or persistent work.

## Shared Scalars

| Name | Contract |
| --- | --- |
| `skillId` | Existing lowercase hyphenated syntax, maximum 80 characters |
| `revision` | Existing exact non-mutable revision syntax, maximum 128 characters |
| `sha256` | Exactly 64 lowercase hexadecimal characters |
| `gitCommitSha` | Exactly 40 lowercase hexadecimal characters |
| `resourcePath` | Existing normalized safe relative path, maximum 240 characters |
| `invocationContext` | `automatic | user-requested` |
| `invocationMode` | `automatic | user-only` |
| `currentClassification` | For agent-visible imports: `verified | curated` |
| imported `trustAtPublication` | Immutable literal `structurally-verified` |

`verified` and `structurally-verified` are structural/provenance/integrity claims only, not semantic
approval, harmlessness, correctness, or endorsement.

## `search_skills`

### Input

```json
{
  "task": "string, 1..4096 UTF-8 bytes",
  "repositoryHash": "optional sha256",
  "limit": "optional integer 1..10",
  "invocationContext": "optional automatic | user-requested"
}
```

- Missing `invocationContext` is interpreted as `automatic`.
- The task string, including an exact skill name, never changes invocation context.
- `automatic` excludes every `user-only` imported revision before ranking.
- `user-requested` permits otherwise eligible user-only revisions to compete normally; it does not
  bypass relevance, classification, advisory, account, or rate-limit checks.
- No GitHub or ingestion work occurs in this call.

### Existing first-party preview

The existing object remains valid and unchanged:

```json
{
  "rank": 1,
  "skillId": "existing-skill",
  "name": "Existing Skill",
  "summary": "Preview only",
  "matchingCapabilities": ["capability"],
  "trustAtPublication": "trusted",
  "currentAdvisoryStatus": "available",
  "revision": "v1"
}
```

### Imported preview

An imported preview includes the existing fields plus required external-only metadata:

```json
{
  "rank": 1,
  "skillId": "gh-12345-ask-matt-a1b2c3d4",
  "name": "ask-matt",
  "summary": "Preview only; never instructions",
  "matchingCapabilities": ["clarification"],
  "trustAtPublication": "structurally-verified",
  "currentAdvisoryStatus": "available",
  "revision": "gh-<64 lowercase bundle hash>",
  "catalogOrigin": {
    "kind": "github",
    "owner": "mattpocock",
    "repository": "skills",
    "commitSha": "84fdeffd12f2ee307994d1eb6feb48173b6e0502",
    "skillPath": "skills/ask-matt/SKILL.md",
    "license": {
      "spdxId": "MIT",
      "attribution": "Matt Pocock"
    }
  },
  "currentClassification": "verified",
  "invocationMode": "user-only"
}
```

Bounds:

- owner/repository: validated GitHub display components, each at most 100 characters
- `skillPath`: normalized repository-relative path, at most 512 characters
- SPDX ID: versioned allowlist, at most 64 characters
- attribution: plain text, at most 200 characters

Search never returns instructions, resource content, license/notice bodies, validation evidence,
dependency excerpts, discovery query/evidence, or arbitrary repository content.

### Eligibility and ranking

1. Load first-party metadata and only the current atomically published imported snapshot.
2. Exclude discovered, quarantined, unavailable, and revoked imports.
3. In automatic context, exclude user-only imports.
4. Apply the existing positive textual relevance gate. If every candidate has zero relevance, return
   an empty array.
5. Apply existing bounded repository-memory boosts only to positively relevant candidates.
6. Use the existing deterministic score/tie rules, with final stable `skillId`/revision ordering
   across both providers.

Repository memory remains account/repository scoped and never changes global import classification.

## `load_skill`

### Input

Unchanged:

```json
{
  "skillId": "exact SkillWire skill identity",
  "revision": "exact immutable revision",
  "repositoryHash": "optional sha256"
}
```

No `latest`, branch, tag, URL, GitHub coordinate, or commit selector is accepted.

### Existing first-party output

The current Feature 001 output remains unchanged and continues using the existing
`publishedProvenance` v1 shape and `trustAtPublication: "trusted"`.

### Imported output

An imported output keeps every existing field and adds external metadata:

```json
{
  "skillId": "gh-12345-ask-matt-a1b2c3d4",
  "revision": "gh-<64 lowercase bundle hash>",
  "revisionSha256": "<64 lowercase complete bundle hash>",
  "publishedProvenance": {
    "source": {
      "provider": "github",
      "reference": "github:12345:skills/ask-matt/SKILL.md"
    },
    "sourceRevision": "84fdeffd12f2ee307994d1eb6feb48173b6e0502",
    "owner": "Matt Pocock",
    "license": "MIT",
    "trustAtPublication": "structurally-verified"
  },
  "currentAdvisoryStatus": "available",
  "instructions": "complete immutable Markdown instructions",
  "resourceManifest": [
    {
      "path": "PHASE-BOUNDARIES.md",
      "mediaType": "text/markdown",
      "byteLength": 1234,
      "sha256": "<64 lowercase resource hash>"
    }
  ],
  "memoryRecorded": false,
  "catalogOrigin": {
    "kind": "github",
    "owner": "mattpocock",
    "repository": "skills",
    "commitSha": "84fdeffd12f2ee307994d1eb6feb48173b6e0502",
    "skillPath": "skills/ask-matt/SKILL.md",
    "license": {
      "spdxId": "MIT",
      "attribution": "Matt Pocock"
    }
  },
  "currentClassification": "verified",
  "invocationMode": "user-only",
  "dependencies": []
}
```

Each dependency has the bounded shape:

```json
{
  "skillId": "exact same-source target skill ID",
  "revision": "exact target revision",
  "required": true,
  "evidenceKind": "manifest | frontmatter | explicit-invocation"
}
```

Dependency evidence excerpts and resource/license bodies are absent. Instructions are the only
content body returned by load. Supplying `repositoryHash` records usage through the unchanged
transactional memory path after exact revision/advisory/classification validation; omitting it stores
nothing.

### Availability

- Unknown, discovered, quarantined, or revoked exact imports return the existing non-disclosing
  not-found result.
- An unavailable previously published import may load exactly from PostgreSQL because its verified
  immutable bundle is upstream-independent; the response states `currentAdvisoryStatus:
  "unavailable"`.
- A content/hash/provenance verification failure fails closed and records no memory usage.

## `read_skill_resource`

Input and output schemas remain unchanged. For an imported exact revision:

- the provider reads only the manifest-declared PostgreSQL content object;
- exact path, media type, byte length, resource SHA-256, and complete revision bundle hash are
  reverified;
- traversal, aliases, undeclared paths, corrupt content, classification/advisory denial, and unknown
  revisions use existing errors;
- exactly one textual body is returned;
- unavailable behaves like exact load, while revoked is non-disclosing not found;
- no GitHub request or client-tree write occurs.

## Error and Side-Effect Contract

Existing MCP error codes/status mapping remain authoritative.

| Condition | Observable result | Side effects |
| --- | --- | --- |
| Strict schema or unsafe resource path fails | Existing invalid-request response | No DB/network/memory write |
| Auth/key/account/rate failure | Existing non-disclosing response | Existing bounded security event only |
| Unknown/discovered/quarantined/revoked identity | Existing not-found response | No memory write |
| Deadline/cancellation/provider integrity failure | Existing internal/non-disclosing response | Transaction rollback; no late usage write |
| Search has no positive relevance | `{ "skills": [] }` | No memory write; no GitHub work |

## Contract Verification

- Generated JSON Schema drift tests cover the discriminated first-party/imported unions.
- All existing Feature 001 request/response fixtures must still parse without modification.
- The six-tool inventory test remains exact.
- Tests reject all source/network fields on every agent tool and prove zero fetch calls.
- Search → exact load → one declared resource completes in at most three MCP calls and leaves the
  client filesystem byte-for-byte unchanged.
