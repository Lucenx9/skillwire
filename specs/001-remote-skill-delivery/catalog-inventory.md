# Launch Catalog Inventory

The MVP contains exactly ten first-party, allowlisted, text-only skills. Before publication, each
source directory contains `SKILL.md`, `provenance.json`, and exactly one declared textual resource.
Publication never writes inside those source directories. It atomically creates the complete batch
under `catalog/releases/launch-catalog-v1/`.

| Skill identifier | Purpose | Exact resource path | Owner | License | Repository source reference | Immutable source revision | Trust rationale |
|------------------|---------|---------------------|-------|---------|-----------------------------|---------------------------|-----------------|
| `typescript-code-review` | Review TypeScript changes for correctness, type safety, maintainability, and regressions. | `references/review-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/typescript-code-review` | `1.0.0` | First-party authored and reviewed for strict TypeScript review; source and license verified at publication. |
| `react-accessibility` | Review React interfaces for accessible structure, semantics, input, focus, and feedback. | `references/accessibility-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/react-accessibility` | `1.0.0` | First-party authored and reviewed for accessibility analysis; source and license verified at publication. |
| `node-api-design` | Design and review clear, compatible, secure Node.js service interfaces. | `references/api-review-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/node-api-design` | `1.0.0` | First-party authored and reviewed for service-interface design; source and license verified at publication. |
| `postgres-schema-review` | Review PostgreSQL schemas, constraints, indexes, migrations, and data integrity. | `references/schema-review-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/postgres-schema-review` | `1.0.0` | First-party authored and reviewed for relational data design; source and license verified at publication. |
| `vitest-test-design` | Design focused Vitest unit, contract, integration, and failure-path coverage. | `references/test-design-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/vitest-test-design` | `1.0.0` | First-party authored and reviewed for test-design guidance; source and license verified at publication. |
| `threat-modeling` | Identify assets, trust boundaries, attacker goals, abuse cases, and mitigations. | `references/threat-model-template.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/threat-modeling` | `1.0.0` | First-party authored and security-reviewed for defensive threat modeling; source and license verified at publication. |
| `github-actions-ci` | Design maintainable GitHub Actions validation and delivery workflows. | `references/ci-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/github-actions-ci` | `1.0.0` | First-party authored and reviewed for CI workflow design; source and license verified at publication. |
| `dockerfile-hardening` | Review container builds for minimal images, least privilege, reproducibility, and secret safety. | `references/hardening-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/dockerfile-hardening` | `1.0.0` | First-party authored and security-reviewed for container hardening; source and license verified at publication. |
| `technical-documentation` | Produce accurate, audience-appropriate technical documentation and validation guides. | `references/documentation-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/technical-documentation` | `1.0.0` | First-party authored and reviewed for technical communication; source and license verified at publication. |
| `dependency-upgrade-planning` | Plan dependency upgrades with compatibility research, migration steps, tests, and rollback. | `references/upgrade-checklist.md` | SkillWire maintainers | Apache-2.0 | `skillwire/catalog/skills/dependency-upgrade-planning` | `1.0.0` | First-party authored and reviewed for safe dependency evolution; source and license verified at publication. |

## Machine-Readable Inputs

- `catalog/inventory.json` contains exactly these ten entries, sorted by identifier.
- Source content is under `catalog/skills/<skill-id>/1.0.0/`.
- `provenance.json` contains exact source reference, source revision, owner, license, and immutable
  `trustAtPublication` rationale.
- Every manifest declares exactly the resource path in this table.
- `evaluation/search-ranking.v1.json` and `evaluation/three-call-journeys.v1.json` are committed and
  reviewed before ranking or journey implementation.
- Canonical, corrupt, advisory, and GitHub-release fixtures are committed before the code they score
  or validate.

## Atomic Published Layout

The genesis command is:

```bash
pnpm catalog:publish -- --release-id launch-catalog-v1 --genesis
```

On success it creates exactly one visible release directory:

```text
catalog/releases/launch-catalog-v1/
├── release.json
└── revisions/
    ├── dependency-upgrade-planning.json
    ├── dockerfile-hardening.json
    ├── github-actions-ci.json
    ├── node-api-design.json
    ├── postgres-schema-review.json
    ├── react-accessibility.json
    ├── technical-documentation.json
    ├── threat-modeling.json
    ├── typescript-code-review.json
    └── vitest-test-design.json
```

After validation, the publisher atomically creates the exclusive
`catalog/releases/.publish-claim` directory. While holding it, the publisher rescans revision
identities, builds this complete structure in a sibling staging directory, and performs one
same-filesystem rename after serialization, hashes, writes, and syncs succeed. A failure exposes none
of the batch. An existing or stale claim, destination, or revision identity rejects the whole batch;
the publisher never overwrites, automatically reclaims a claim, or partially replaces a batch.

`release.json` contains the canonical inventory hash, genesis marker, nullable
`previousReleaseCommit`, advisory-chain head, count of ten, and a sorted summary pointing to each
revision record. Structured command output reports a result for every identifier above.

## Required Publication Order

1. Define domain types and canonical formats.
2. Commit the exact inventory.
3. Author all ten instructions and resources.
4. Establish all ten published provenance records.
5. Review immutable canonical/hash and release fixtures.
6. Normalize and build all ten canonical bundles in memory.
7. Calculate each resource hash and complete bundle hash.
8. Validate the advisory chain and proposed release metadata.
9. Run the create-only atomic `catalog:publish` batch.
10. Run the separate read-only `catalog:verify` command.

No provider, ranker, MCP handler, or runtime loader is implemented against an unpublished batch.

## Release and Advisory Validation

Genesis is explicit: `genesis` is true, `previousReleaseCommit` is null, and the advisory head is the
defined empty-chain value unless genesis advisories are present. CI fully paginates the accessible
GitHub repository's releases and proves there is no non-draft release, including no prerelease. The
local verifier proves there is no earlier batch and the candidate chain is an initial chain.

For every later batch, `previousReleaseCommit` is an exact 40-character commit SHA. CI retrieves
the unique latest `draft: false` GitHub release by `published_at`, including a published prerelease,
resolves its tag—including annotated tags—to that exact commit, requires equality with the metadata
field, and retrieves the previous chain at that SHA.
Missing or unavailable release state fails closed. Merge bases, branches, release
`target_commitish`, and optional fallback references are never used.

Runtime reads the configured immutable release directory and version-controlled advisory chain. It
cannot publish, rewrite release metadata, or edit advisories.
