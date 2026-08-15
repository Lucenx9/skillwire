# Self-hosted release evidence

This document defines the evidence required before a public self-hosted release.
It is not itself proof that a candidate passed. A candidate is releasable only
when every required row names an immutable source commit, release manifest
SHA-256, architecture, workflow run/job URL, command, outcome, cleanup result,
and retained redacted artifact identity.

## Certified matrix

The claimed matrix is exactly Ubuntu 24.04, Debian 12, and Debian 13 on Linux
`amd64` and `arm64`, each with configured rootful and rootless Docker. Tool
versions are defined by `distribution/self-hosted/supported-matrix.json`: Node
24.18.0, pnpm 11.21.0, PostgreSQL 17.10, Codex 0.147.0, Claude Code 2.1.229,
Cosign 3.1.3, Docker minimum 29.7.2, and Compose minimum 5.4.0. A missing runner
or skipped real boundary is `not-certified`, never an inferred pass.

Each matrix cell must record signed-asset verification, safe extraction,
first-party offline setup, normal-profile client lifecycle, fail-open startup,
real Secret Service, PostgreSQL backup/restore, same-schema and forward-only
upgrade, selective uninstall, retained reinstall, purge, resource cleanup, and
the 28-scenario gate. CI fixtures may prove deterministic logic but do not
replace a real Docker, PostgreSQL, client-manager, D-Bus/keyring, or
architecture boundary named by an acceptance contract.

Certification requires exactly one observation for each of the 12 Cartesian
cells. Every observation is bound to the same final
`self-hosted-v<package.version>` annotated tag, source commit, and exact seven
published assets: an archive, canonical manifest, and corresponding signature
bundle for each architecture, plus the trust policy. A failed or incomplete cell
remains failed or incomplete; it cannot be replaced, rerun as a substitute, or
silently excluded from the matrix. No cell is claimed as passed by this
preparation patch.

## Required deterministic gates

- formatting, ESLint, strict TypeScript, build, migrations and idempotent rerun;
- unit, contract, integration, E2E, evaluation and security projects;
- `test:feature-004`, all 28 numbered scenarios, and FR-001–FR-092 traceability;
- catalog and advisory verification, Feature 003 package/integrity and
  activation;
- default, test-overlay and self-hosted Compose validation;
- canonical manifest, archive inventory/extraction, Sigstore/Cosign trust,
  rotation/revocation/downgrade and digest-pinned image gates;
- secret canary, symlink/containment/ownership and zero-unrelated-write scans;
- disposable quickstart cleanup and `git diff --check`.

Automatic activation is a separate experimental evidence claim. Deterministic
client setup succeeds on the exact six-tool and scripted search/load/resource
journey even when a fresh-client automatic diagnostic observes no invocation. Do
not turn a deterministic setup pass into an autonomous-activation claim.

## Duration and moderated usability

The 15-minute target is not a deterministic CI wall-clock timeout, but it is a
normative moderated-release threshold. Follow
`docs/self-hosted-moderated-usability.md` with exactly ten independent,
first-attempt participants and validate the privacy-safe cohort against
`distribution/self-hosted/moderated-usability.schema.json` plus the semantic
validator. SC-001 requires 10/10 participants to complete within 900,000
milliseconds. SC-014 requires at least 9/10 completed journeys without a
moderator intervention. Timeout, abandonment, unrecovered error, replacement,
rerun, or post-assignment exclusion never improves the denominator.

No participant run is recorded for the current uncommitted candidate. Release
readiness therefore remains blocked until immutable commit-bound artifacts and
all required matrix/usability evidence exist. Residual risk must list every
gated skip, unsupported runner, environment dependency, and separately deferred
automatic-activation claim; absence of evidence is never reported as success.

## Local uncommitted pre-release record — 2026-08-14

This record is diagnostic evidence for the working tree, not release
certification. The implementation has no immutable source commit, external
canonical manifest, archive digest, Sigstore bundle, or tag yet. The host is
CachyOS `x86_64`, outside the supported matrix; results MUST NOT be generalized
to Ubuntu, Debian, `arm64`, or rootless Docker.

- Tooling: Node 24.18.0, pnpm 11.21.0, Docker Engine 29.7.2, Compose 5.4.0,
  PostgreSQL 17.10-alpine, and Actionlint 1.7.12.
- Full bounded offline suite: 164 files passed, 3 files skipped; 848 tests
  passed and 9 expected environment-gated tests skipped. The extra full-suite
  skip was the separately gated live-GitHub smoke; GitHub remained disabled.
- Feature 004 aggregate: 72 files passed, 2 files skipped; 350 tests passed and
  8 expected environment-gated tests skipped. All 28 numbered scenarios and
  FR-001 through FR-092 remained mapped to executable passing suites.
- Feature 003: activation 98/98; activation adapter 65/65; package validation
  retained version 0.1.1, source commit
  `7d9fd5fd130c9e66dfb739c599fd84ad9d962d5a`, and package SHA-256
  `f4e2e1cca7b4c99d41d585d2816b44b4203297ad15809e3c1b87bedb8b6e805e`.
- Real disposable boundaries: GNOME Keyring/Secret Service 4/4, including the
  separate GitHub source token; PostgreSQL backup and isolated restore 9/9. A
  preliminary restore rerun stopped before database creation because the first
  disposable daemon exhausted its IPAM pool; the unchanged test passed on a
  fresh daemon with an explicit private address pool.
- Migrations: two consecutive runs reported current; the disposable database
  contained exactly 10 registered migrations through `010`.
- Static and integrity gates: Prettier, ESLint, strict TypeScript, build,
  catalog, advisory chain, Feature 003 package, Actionlint, and
  `git diff --check` passed. Default, test-overlay, benchmark-overlay, and
  self-hosted Compose rendering passed.
- Cleanup: the disposable PostgreSQL databases, custom Docker daemons,
  containers, volumes, images, networks, bridge, D-Bus/keyring provider,
  sockets, profiles, and test roots were removed. No normal client profile,
  desktop keyring, or shell configuration was used. During the final local suite
  rerun, restoring a missing host Docker bridge restarted a pre-existing
  `skillwire` Compose project for approximately two minutes. Tests continued to
  use isolated Testcontainers databases and did not target that project, but
  PostgreSQL startup/shutdown means byte-for-byte non-mutation of its persistent
  volume cannot be certified. Docker was returned to its initial inactive,
  socket-free state without deleting or inspecting that volume.

The real signed-asset quickstart, all 12 certified matrix cells, moderated
participant target, and automatic-activation release claim were not run or
claimed. Those missing immutable and external boundaries keep T161 and public
release readiness open. Because the canonical manifest is an external release
asset, no repository metadata commit is needed after signing: first commit the
implementation, tag that exact immutable commit, and let the protected workflow
build the archive and external manifest from that tag commit before signing the
manifest. Committing generated manifest bytes back into the source tree would
create the circular identity this workflow deliberately avoids.
