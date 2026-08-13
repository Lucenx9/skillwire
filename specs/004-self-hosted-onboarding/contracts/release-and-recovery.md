# Contract: Release, Deployment, Backup, Upgrade, and Recovery

## Trust bootstrap

The supported workflow starts with four exact sibling assets for one platform:

```text
skillwire-<release>-linux-<arch>.tar.zst
skillwire-<release>-linux-<arch>.release.json
skillwire-<release>-linux-<arch>.release.sigstore.json
skillwire-trust-policy-v<sequence>.json
```

The bootstrap instructions in `distribution/self-hosted/README.md` require an independently verified, release-pinned Cosign 3.1.3 plus a local Sigstore TrustedRoot before any archive byte is extracted or executed; `curl | sh` is not supported. Cosign itself is obtained from the exact `sigstore/cosign` v3.1.3 release and verified using Sigstore's official TUF `artifact.pub` procedure and matching official release bundle. Its per-platform SHA-256 must then match the selected trust policy.

Bootstrap runs `cosign verify-blob` with outbound network blocked, the local trusted root, external bundle, canonical release manifest, exact certificate identity/issuer, and the policy-required repository/workflow/tag/SHA claims. It then validates canonical encoding, policy/manifest sequences, archive size/digest, and deny lists before extraction. Once started, the CLI independently repeats the same release-pinned verification before any installation path, image, container, service secret, credential, client profile, or database mutation. Missing or stale trusted material is a blocking integrity result with bounded instructions for an explicit TUF refresh; verification never silently refreshes or performs an unbounded transparency lookup.

## Signing and trust-policy contract

`.github/workflows/self-hosted-release.yml` is the only release signer. The protected-tag workflow checks out the exact `v<release-id>` commit, builds and completes all acceptance gates before signing, grants only `contents: read` and `id-token: write`, and invokes:

```text
cosign sign-blob --yes \
  --timeout 2m \
  --oidc-provider github-actions \
  --signing-algorithm ecdsa-sha2-256-nistp256 \
  --bundle skillwire-<release>-linux-<arch>.release.sigstore.json \
  skillwire-<release>-linux-<arch>.release.json
```

Cosign is pinned to 3.1.3. The bundle media type is exactly `application/vnd.dev.sigstore.bundle.v0.3+json` and contains the message signature, Fulcio certificate, signed transparency/timestamp evidence, and inclusion proof needed for offline verification. Publication fails when signing or required transparency material is absent.

The exact issuer is `https://token.actions.githubusercontent.com`. For release `<release>`, the exact certificate identity is `https://github.com/Lucenx9/skillwire/.github/workflows/self-hosted-release.yml@refs/tags/v<release>`. Verification additionally pins repository `Lucenx9/skillwire`, workflow ref, tag ref, and exact workflow commit-SHA claims.

With outbound network denied, installer/bootstrap verification invokes the policy-pinned Cosign binary directly with no shell and this exact interface:

```text
cosign verify-blob \
  --timeout 30s \
  --bundle skillwire-<release>-linux-<arch>.release.sigstore.json \
  --trusted-root <policy-pinned-local-trusted-root.json> \
  --certificate-identity \
    https://github.com/Lucenx9/skillwire/.github/workflows/self-hosted-release.yml@refs/tags/v<release> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository Lucenx9/skillwire \
  --certificate-github-workflow-ref refs/tags/v<release> \
  --certificate-github-workflow-sha <exact-40-hex-tag-commit> \
  skillwire-<release>-linux-<arch>.release.json
```

The verifier does not pass `--insecure-ignore-sct`, `--insecure-ignore-tlog`, a regular-expression identity/issuer, or a network-derived root. Before spawning, it validates every argument as bounded policy data and the manifest/bundle/root as exact contained regular files. It separately parses the returned Bundle v0.3 and policy evidence so process exit alone cannot bypass media-type, deny-set, sequence, claim, transparency, or digest checks.

`skillwire.trust-policy/v1` is RFC 8785 canonical JSON and contains a monotonic policy sequence, validity window, exact accepted signer claims, TrustedRoot media type/path/SHA-256, allowed Cosign version/platform/SHA-256 entries, minimum release sequence, deny set, and signer-rotation evidence. The first policy is pinned in source and the bootstrap README. Installation state records the highest accepted policy and release sequences; lower sequences, changed hashes, unknown policies, invalid/legacy bundles, denied material, wrong claims, missing overlap proof, or invalid transparency/timestamp evidence fail before extraction or mutation.

For an update, the active installed policy first verifies the release manifest; the manifest's signed next-policy hash then authenticates that policy before it can become active. Signer rotation requires an old-policy-authorized policy update and an overlap release carrying the normal bundle plus an additional `skillwire-<release>-linux-<arch>.release.<new-signer-id>.sigstore.json`; the manifest enumerates both ordered filenames and signer identities, each Bundle v0.3 independently binds the canonical manifest digest, and the verifier hashes the bundle bytes to reject duplicate evidence before verifying each exact signer policy. Bundle digests cannot be fields of the manifest the bundles themselves sign because that would create a circular hash dependency. A later old-policy-authorized update may remove the old signer. Emergency revocation is an old-policy-authorized deny-set update. If no trusted signer survives, automatic update stops and recovery requires a separately authenticated out-of-band bootstrap. Offline verification cannot discover a later revocation, so every new install/upgrade must use the latest explicitly refreshed policy; cached evidence is scoped to its recorded policy sequence.

## Release bundle

One archive is published per certified platform and contains only payload bytes bound by the external manifest:

```text
skillwire-<release>-linux-amd64/
skillwire-<release>-linux-arm64/
├── bin/skillwire
├── runtime/node
├── app/skillwire.mjs
├── compose/compose.yaml
├── catalog/
├── migrations/
├── integrations/
│   ├── codex-marketplace/
│   └── claude-marketplace/
└── licenses/
```

Paths are normalized UTF-8 relative paths with no empty, dot, traversal, absolute, drive, control, link, device, or duplicate entry. Extraction uses explicit size/file-count bounds, rejects links/special files, creates an exclusive staged owned directory, verifies all identities, syncs it, and atomically installs the immutable release directory.

## Manifest contract

`skillwire-<release>-linux-<arch>.release.json` is external to the archive, UTF-8 RFC 8785 JSON Canonicalization Scheme output with no BOM and no trailing newline. It uses `schemaVersion: skillwire.release/v1` and binds:

- release ID, monotonic release sequence, and publication time;
- exact target OS/architecture;
- sibling archive filename, media type, byte size, and SHA-256;
- supported OS, Docker Engine, Compose, PostgreSQL, Codex, and Claude versions;
- the complete extracted payload inventory: every archive file's path, role, byte size, mode, and SHA-256;
- application and PostgreSQL image repository plus exact per-platform digest;
- production Compose hash and stable expected topology;
- ordered migration versions/hashes and forward-only markers;
- first-party catalog release/hash, ten revision identities, and advisory-head hash;
- Codex/Claude plugin, marketplace, version, inventory, source, and aggregate hashes;
- existing exact six-tool contract hash and activation-policy versions;
- exact path, byte size, and SHA-256 of Feature 003's `distribution/codex-marketplace/release-integrity.json`;
- minimum/maximum compatible database schema and rollback rules;
- required trust-policy schema/sequence/sibling filename/byte size/SHA-256;
- one normal, or two signer-overlap, external Sigstore Bundle v0.3 filenames/media types/digests and the canonical manifest SHA-256.

The manifest contains no registry credential, client key, GitHub token, database password, pepper, account ID, repository identity, or host path. A changed artifact requires a new manifest/release; a signature never authorizes bytes omitted from the artifact list.

## Production Compose invariants

- No `build`, moving tag, arbitrary checkout mount, Docker socket mount, privileged mode, host network, or remote context.
- Application and migration services use the exact SkillWire digest; PostgreSQL uses the exact 17.10 digest.
- Only SkillWire is host-published, on the exact loopback address/selected port. PostgreSQL is not host-published.
- The persistent PostgreSQL named volume has a stable installation-owned identity and is never recreated for repeated setup/repair/upgrade.
- Secrets are restrictive host files granted only to the services that need them; they are not environment-sourced and never passed to `docker compose config` output.
- Migration is a one-shot service gated on healthy PostgreSQL; application waits for migration success and exposes distinct liveness/readiness checks.
- Application/migrator run as non-root UID/GID 10001 with read-only root filesystem, dropped capabilities, `no-new-privileges`, bounded tmpfs, and no writable catalog/migration mounts.
- The official PostgreSQL image retains its documented entrypoint/user behavior and isolated internal network.
- Commands run from the immutable release directory with explicit Compose file/project, sanitized environment, `--no-build`, bounded deadlines, and verified image inspections.

Setup accepts an already functioning local rootless or rootful context and discloses which. It never installs Docker, changes daemon settings, adds group membership, elevates, or selects a remote context.

## Installation layout

Using XDG defaults when variables are absent:

```text
$XDG_CONFIG_HOME/skillwire/          non-secret configuration
$XDG_DATA_HOME/skillwire/
├── releases/<release-id>/           immutable verified releases
├── trust/                           versioned policies, TrustedRoot, verifier identities
├── installations/<installation-id>/
│   └── secrets/                     database password and application pepper
├── credentials/...                  confirmed restrictive fallback only
└── backups/<backup-id>/              protected backup sets
$XDG_STATE_HOME/skillwire/
├── installation.json
├── ownership.json
├── operations/<operation-id>.json
└── snapshots/
$XDG_CACHE_HOME/skillwire/            non-authoritative verified downloads
$XDG_RUNTIME_DIR/skillwire/           locks/FIFOs/transient staging only
~/.local/bin/skillwire                stable SkillWire-owned entry point
```

Every target is absolute, contained, link-safe, invoking-UID-owned, and restrictively permissioned. A pre-existing unowned target blocks replacement. Runtime content is never the sole journal, secret, backup, or recovery record.

Database/application secret generation, reuse, validation, rotation, retention, and removal follow [service-secrets.md](./service-secrets.md). Setup, repair, upgrade, and reinstall never regenerate or rotate valid service secrets.

## Backup contract

A valid backup directory contains:

```text
<backup-id>/
├── database.dump
├── recovery-manifest.json
├── checksums.json
└── validation.json
```

Creation rules:

1. Create an exclusive mode-`0700` backup directory and mode-`0600` files.
2. Use the release-pinned PostgreSQL client to run `pg_dump -Fc` through direct spawned pipes, not a shell or host-published database port.
3. Record source release/schema/migration hashes, catalog/advisory identities, Compose project/volume, installation/ownership revision, credential reference IDs, and retention boundary. Do not copy raw secrets or unrelated client state.
4. Sync and hash every file.
5. Create a new unpublished isolated PostgreSQL 17.10 validation volume and empty database derived from `template0`.
6. Restore with `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`.
7. Verify exact migration rows/checksums, representative authoritative data/counts, constraints, catalog/advisory integrity, and service readiness against the restored database.
8. Destroy only the validation containers/volume and atomically mark the backup `valid` after all checks pass.

An imported/truncated/modified/wrong-version dump is untrusted and invalid until the same isolated validation succeeds. Restore executes database content and therefore never targets the active database during validation. A missing retained secret becomes an explicit credential-rotation/recovery prerequisite; it is never silently reconstructed or embedded in the backup.

## Upgrade state machine

```text
target verified
  -> trust policy and anti-downgrade sequences accepted
  -> compatibility evaluated
  -> pre-upgrade backup created and restore-validated
  -> final preview/confirmation
  -> writers drained when boundary requires
  -> target files/images staged
  -> existing migration gate
  -> live schema re-read
  -> target service ready/catalog/advisory valid
  -> each retained client deterministically verified
  -> active release committed
```

At every transition, the operation journal is synced before and after effect.

Rollback rules:

| Observed live schema | Target/previous compatibility | Allowed recovery |
|----------------------|-------------------------------|------------------|
| No new migration applied | Previous release supports schema | Automatic application/config rollback. |
| New reversible migration declared and both releases support schema | Manifest explicitly permits | Automatic application/config rollback; database remains. |
| Migration 010 applied, previous release is pre-010 | Incompatible | Refuse image-only rollback; keep writers stopped; require validated restore or compatible post-010 release. |
| Live schema newer than target or checksum drifted | Incompatible/untrusted | Start no target/older app; return schema incompatibility/recovery guidance. |
| Post-migration verification failed and no compatible app available | Restore required | Identify validated backup, compatible release, data-loss timestamp, and erased-memory warning. |

Upgrade preserves client credentials, ownership, repository memory, database volume, backups, source state, and unrelated profile content. It never rotates keys merely because configuration or service repair is needed.

## Interruption and concurrency recovery

Mutations acquire one installation lock containing PID, boot ID, and process-start identity. A contender exits without mutation. A stale lock is quarantined only after proving that exact process no longer exists; elapsed time alone is insufficient.

Recovery reads the durable journal and observed state:

- intent persisted, effect absent: safely retry or compensate that step;
- effect equals expected after identity, commit record absent: verify then commit the step;
- owned client effect partially present and current identity matches expected installer image: run the scoped vendor inverse;
- concurrent/unrelated profile drift: stop with conflict guidance, never restore whole-file snapshot;
- schema crossed forward-only boundary: change rollback boundary to `database-restore-required` based on live `schema_migrations`, not journal assertion alone;
- final success transition absent: never report completion.

Fault tests inject termination after every persisted intent, external mutation, verification, compensation, and commit boundary.

## Default uninstall and permanent removal

Default uninstall:

- removes only currently matching owned client MCP/plugin/marketplace state;
- leaves every external dependency untouched;
- stops/removes owned application/migration/PostgreSQL containers and network;
- preserves PostgreSQL volume, backups, application/database/client secrets, immutable releases required for reinstall/restore, installation ID, ownership, and recovery journals;
- reports all retained exact owned locations and supports duplicate-free reinstall.

Permanent removal is the separate `skillwire purge` operation. Its preview and confirmation name the installation ID and every exact owned retained path/volume/credential. It deletes only matching owned targets. External, ambiguous, drifted, or newly concurrent targets are not deleted. The result explicitly lists removed unrecoverable material and anything retained with reason.

## Release acceptance evidence

Publication is blocked unless evidence records exact release, commit, OS image, architecture, Docker Engine, Compose, PostgreSQL image digest, Codex, Claude, Node runtime, plugin/marketplace hashes, and test results for:

- all existing Feature 001-003 gates and invariants;
- all 28 Feature 004 numbered acceptance scenarios;
- Codex-only, Claude-only, both, and neither setup;
- repeated setup, dual-client partial failure, external reuse, conflicts, managed policy, profile preservation, and zero repository writes;
- exact six-tool bridge discovery and deterministic smoke journey;
- separate automatic and explicit user-requested evidence;
- outage/auth/contract failures with ordinary client startup;
- every journal interruption boundary and concurrent mutator;
- Secret Service and confirmed restrictive fallback;
- independent database/application service-secret generation, byte-for-byte reuse, explicit rotation rollback, and disclosure scans;
- the sole dispatcher route, JSON/MCP stdout purity, signals, and documented exit mapping;
- Cosign 3.1.3 bootstrap verification, keyless tag signing, Bundle v0.3 offline verification, trust-policy rotation/revocation, and release/policy downgrade rejection;
- the exact Feature 003 `distribution/codex-marketplace/release-integrity.json` hash and all unchanged Feature 003 package/evaluation integrity gates;
- canary scanning of process/config/log/backup/report/repository surfaces;
- no-schema and migration-010 upgrade/rollback/restore;
- default uninstall, reinstall, and separately confirmed purge;
- Ubuntu 24.04 and Debian 12/13 on `amd64` and `arm64`, rootless and rootful where supported.

Claims apply only to the recorded matrix. A new client/runtime major or platform requires new compatibility evidence and manifest metadata.
