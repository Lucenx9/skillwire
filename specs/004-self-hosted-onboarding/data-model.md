# Data Model: Self-Hosted Onboarding and Native Client Integration

Feature 004 adds host-side lifecycle state. Existing PostgreSQL account/API-key, catalog, provenance, advisory, external-source, audit, and repository-memory entities remain authoritative and unchanged. Host-side records are versioned, bounded JSON stored with restrictive permissions so lifecycle commands still work when the service or database is unavailable.

## 1. SkillWire Installation

One user-owned deployment.

| Field | Type | Constraints |
|-------|------|-------------|
| `schemaVersion` | literal | `skillwire.installation/v1`. |
| `installationId` | UUID | Generated once; stable across repair, upgrade, default uninstall, and reinstall. |
| `ownerUid` | non-negative integer | Must equal the invoking effective UID for mutation. |
| `accountId` | UUID | Existing local account identity; protected and never emitted in logs/reports. |
| `activeReleaseId` | string | Must reference one verified installed release. |
| `highestAcceptedReleaseSequence` | non-negative integer | Monotonic anti-downgrade boundary; never lowered by setup, upgrade, repair, or restore. |
| `activeTrustPolicySequence` | positive integer | Highest verified policy selected for release verification. |
| `endpoint` | URL | Exact loopback HTTP MCP endpoint; no user info, query, or fragment. |
| `composeProject` | string | Stable, bounded project name owned by this installation. |
| `dockerContext` | record | Local context name, endpoint kind, rootless flag, engine/Compose versions; remote contexts forbidden. |
| `postgresVolume` | string | Stable named volume; retained until separately confirmed permanent removal. |
| `databaseSchema` | record | Latest applied migration, checksum-set hash, and whether forward-only migration 010 is present. |
| `catalogIdentity` | record | Release ID, catalog hash, advisory-head hash, exactly ten first-party skill identities on a fresh release. |
| `selectedClients` | set | `codex`, `claude`, both, or empty. |
| `clientIntegrationIds` | map | At most one integration ID per selected client. |
| `status` | enum | `prepared`, `service-ready`, `complete`, `incomplete`, `data-retained`, `recovery-required`, `purged`. |
| `lastValidatedAt` | timestamp | Set only after the state represented by `status` is observed. |

Invariants:

- There is at most one active installation record for the owned XDG root.
- `complete` means the service plus every selected client passed deterministic verification; an empty selection may be complete with client integration pending.
- `incomplete` may retain a healthy service and verified client while another independently targeted client was compensated.
- A success marker is never inferred from containers or files alone; it is the final durable journal transition plus fresh validation.
- `accountId`, repository-memory identifiers, and credential material never appear in normal output.

## 2. Release Manifest and Installed Release

Immutable release input and its verified local materialization.

| Field | Type | Constraints |
|-------|------|-------------|
| `schemaVersion` | literal | `skillwire.release/v1`. |
| `releaseId` | semver-like string | Immutable and unique. |
| `releaseSequence` | positive integer | Monotonic publication sequence; must not be below the installation's highest accepted sequence. |
| `publishedAt` | timestamp | Signed manifest metadata. |
| `platform` | enum pair | `linux-amd64` or `linux-arm64`. |
| `archive` | record | Exact sibling archive filename, media type, byte size, and SHA-256. |
| `minimumCompatibility` | record | Exact certified OS, Docker, Compose, Codex, Claude, Node, and PostgreSQL ranges. |
| `artifacts` | ordered array | Complete extracted payload inventory: relative normalized path, media type, byte size, SHA-256, executable bit, and role. No duplicates or links. |
| `images` | ordered array | Canonical repository plus exact platform manifest digest and role. No mutable-tag fallback. |
| `composeSha256` | SHA-256 | Binds the production no-build Compose definition. |
| `migrationSet` | ordered array | Versions 001-010 and SQL hashes; declares `010` as forward-only. |
| `catalog` | record | Release/catalog/advisory identities and hashes. |
| `adapters` | map | Codex and Claude plugin/marketplace identities, versions, inventories, and hashes. |
| `feature003Integrity` | record | Exact path, byte size, and SHA-256 for `distribution/codex-marketplace/release-integrity.json`. |
| `trustPolicy` | record | Required schema, policy sequence, sibling filename, byte size, and SHA-256. |
| `signing` | record | One normal, or two signer-overlap, external Sigstore Bundle v0.3 filename/media-type/digest identities plus exact canonical-manifest digest; no private key. |
| `rollbackCompatibility` | record | Minimum/maximum schema and pre/post-010 application compatibility. |

The release manifest is an external UTF-8 RFC 8785 canonical JSON file with no BOM or trailing newline; it is never embedded in the archive it hashes. An Installed Release adds `installedPath`, verified manifest/archive/bundle/policy identities, verified file identities, image inspection results, verifier/trusted-root identities, and `installedAt`. It is immutable after verification. Changing any byte produces a different release or a failed integrity finding.

## 2A. Trust Policy

Versioned release-verification authority, independent of mutable network state.

| Field | Type | Constraints |
|-------|------|-------------|
| `schemaVersion` | literal | `skillwire.trust-policy/v1`. |
| `policySequence` | positive integer | Monotonic; a lower sequence is never accepted after a higher one. |
| `validity` | record | Explicit not-before/not-after timestamps; staleness is a blocking finding for a new install/upgrade. |
| `acceptedSigners` | non-empty ordered array | Exact Fulcio identity, issuer, repository, workflow ref, tag-ref form, and required workflow commit-SHA claims. |
| `trustedRoot` | record | Sigstore TrustedRoot media type `application/vnd.dev.sigstore.trustedroot.v0.2+json`, local filename, and SHA-256. |
| `cosignVerifiers` | ordered array | Allowed exact Cosign version/platform/filename/SHA-256 identities. |
| `minimumReleaseSequence` | non-negative integer | Releases below this boundary are denied. |
| `denySet` | ordered array | Revoked manifest, archive, bundle, certificate, or signer identities/digests. |
| `rotation` | record | Prior-policy identity and required old/new overlap evidence when signers change. |

The first policy is pinned in the source distribution and bootstrap documentation. A signer rotation is accepted only when an old-policy-authorized update and at least one overlap release prove both old and new signers; removing the old signer requires a later old-policy-authorized update. If no trusted signer survives, automatic update stops for an independently authenticated out-of-band bootstrap.

## 2B. Service Secret Set

Non-secret lifecycle state for the database password and application API-key pepper. Raw values are never represented in the model.

| Field | Type | Constraints |
|-------|------|-------------|
| `serviceSecretSetId` | UUID | Stable for the retained installation secret set. |
| `installationId` | UUID | Parent installation. |
| `secrets` | fixed map | Exactly `database-password` and `application-pepper`. |
| `locator` | structured path | Exact file under `$XDG_DATA_HOME/skillwire/installations/<installation-id>/secrets/`; no value. |
| `identity` | record | File/device/inode metadata, mode, size, and non-reversible keyed verification identity; no raw hash suitable for guessing. |
| `createdByOperation` | UUID | Ownership link. |
| `state` | enum | `available`, `rotating`, `invalid`, `retained`, `removed`. |
| `priorLocator` | optional structured path | Rotation-only retained old file until replacement readiness and commit. |

Each value is generated independently with at least 256 bits of cryptographic entropy and exclusively created in a UID-owned `0700` directory as a UID-owned regular file of mode exactly `0600`, link count one. Setup, repair, and upgrade reuse valid bytes and block on unsafe state. Only the explicit maintenance rotation workflow can replace a value, and it retains the prior value until service readiness and rollback safety are proved.

## 3. Installation Ownership Record

The sole authority for repair and removal.

| Field | Type | Constraints |
|-------|------|-------------|
| `schemaVersion` | literal | `skillwire.ownership/v1`. |
| `installationId` | UUID | Parent installation. |
| `recordRevision` | positive integer | Monotonic; atomic replacement only. |
| `assets` | ordered array | Exact owned asset records; bounded and duplicate-free. |
| `externalDependencies` | ordered array of IDs | References only; never ownership claims. |
| `recordSha256` | SHA-256 | Canonical record integrity. |

Each owned asset contains:

| Field | Type | Meaning |
|-------|------|---------|
| `assetId` | UUID | Stable identity. |
| `kind` | enum | `path`, `release`, `trust-policy`, `service-secret`, `compose-project`, `container`, `volume`, `credential`, `mcp-entry`, `plugin`, `marketplace`, `backup`, `source-registration`. |
| `client` | optional enum | `codex` or `claude` for client assets. |
| `locator` | structured non-secret locator | Exact path/name/reference; no raw credential. |
| `createdByOperation` | UUID | Journal that established ownership. |
| `expectedIdentity` | structured hash/version | Required before later mutation/removal. |
| `retention` | enum | `remove-on-uninstall`, `retain-by-default`, `remove-only-on-purge`. |
| `disposition` | enum | `present`, `removed`, `retained`, `drifted`, `ambiguous`. |

Ownership cannot be inferred from name, endpoint, path prefix, or equivalent behavior. A pre-existing asset never enters `assets` as owned.

## 4. External Integration Dependency

Equivalent state reused without ownership.

| Field | Type | Constraints |
|-------|------|-------------|
| `externalDependencyId` | UUID | Local reference. |
| `client` | enum | `codex` or `claude`. |
| `kind` | enum | `mcp-entry`, `plugin`, or `marketplace`. |
| `scope` | enum | Effective vendor scope; must be allowed for the selected normal profile. |
| `observedIdentity` | structured value | Name, normalized command/endpoint, version/source, and non-secret hashes. |
| `verification` | enum | `equivalent`, `conflicting`, `ambiguous`, `managed`, `unavailable`. |
| `lastObservedAt` | timestamp | Never treated as durable ownership evidence. |

Only `equivalent` dependencies can satisfy setup. Repair, upgrade, default uninstall, and purge do not rewrite or remove them. A changed identity forces reclassification before any owned mutation.

## 5. Client Integration

One independently transacted native integration per client.

| Field | Type | Constraints |
|-------|------|-------------|
| `clientIntegrationId` | UUID | Stable while retained. |
| `installationId` | UUID | Parent installation. |
| `client` | enum | `codex` or `claude`. |
| `clientVersion` | semver string | Must be explicitly certified by the active release. |
| `profileScope` | literal | Normal user scope only. |
| `mcpIdentity` | record | Exact `skillwire` name, stable bridge command/args, effective scope, ownership or external dependency ID. |
| `adapterIdentity` | record | Exact plugin, marketplace, package version/hash, effective state, ownership or external dependency ID. |
| `credentialReferenceId` | optional UUID | Present for an owned bridge credential; never the raw token. |
| `apiKeyId` | optional UUID | Protected service key identity used for revocation; never printed. |
| `snapshotId` | optional UUID | Pre-first-mutation snapshot. |
| `deterministicVerificationId` | optional UUID | Latest successful exact six-tool/smoke evidence. |
| `automaticDiagnosticId` | optional UUID | Separate model-dependent observation. |
| `state` | enum | `planned`, `credential-stored`, `mcp-registered`, `adapter-installed`, `verified`, `external-verified`, `compensating`, `failed`, `removed`, `retained-external`. |

State transitions:

```text
planned
  ├─ equivalent external MCP+adapter verified ─────────> external-verified
  └─ create owned key/store credential ────────────────> credential-stored
       └─ add user MCP ────────────────────────────────> mcp-registered
            └─ install activation adapter ─────────────> adapter-installed
                 └─ deterministic verification ───────> verified

credential-stored | mcp-registered | adapter-installed
  └─ failure ─> compensating ─> failed

verified ── owned uninstall ─> removed
external-verified ── uninstall ─> retained-external
```

Compensation removes only state created by that client transaction, clears its created credential, and revokes only the key created solely for it. Another verified client and the healthy service remain untouched.

## 6. Credential Reference

Non-secret information required to resolve one client-specific bearer key.

| Field | Type | Constraints |
|-------|------|-------------|
| `credentialReferenceId` | UUID | Random opaque lookup attribute. |
| `installationId` | UUID | Parent installation. |
| `client` | enum | Exactly one client. |
| `backend` | enum | `secret-service` or `restrictive-file`. |
| `locator` | record | Secret Service attributes or exact fallback path; contains no token/account/endpoint. |
| `keyPublicIdHash` | SHA-256 | Optional verification fingerprint of the non-secret public token component; no recoverable key material. |
| `createdByOperation` | UUID | Ownership link. |
| `state` | enum | `available`, `missing`, `locked`, `rejected`, `retained`, `removed`. |

Secret Service attributes are non-secret and contain only application, schema version, installation ID, client, and reference ID. File fallback invariants: every owned ancestor is UID-owned mode `0700`; the final regular file is UID-owned mode exactly `0600`, link count one, opened without following links, and atomically replaced in the same directory.

## 7. Profile Snapshot

Secure pre-mutation recovery evidence for one client.

| Field | Type | Constraints |
|-------|------|-------------|
| `snapshotId` | UUID | Operation-local identity. |
| `client` | enum | `codex` or `claude`. |
| `scope` | literal | Normal user profile. |
| `capturedPaths` | array | Only files that the supported manager may mutate; no repository content. |
| `beforeIdentity` | map | File type, owner, mode, size, SHA-256, and structured semantic digest. |
| `encryptedOrProtectedCopy` | locator | Restrictive owned snapshot path; never included in normal diagnostics. |
| `expectedPostIdentity` | optional map | Filled after the manager mutation. |
| `restorationState` | enum | `not-needed`, `eligible`, `restored`, `blocked-by-concurrent-change`, `retained`. |

A full snapshot can be restored only when current identities equal `expectedPostIdentity`; otherwise recovery stops rather than overwriting concurrent user state. Normal reports contain only redacted owned locators and digests, never unrelated profile values.

## 8. Operation Journal

Durable transaction/recovery log for one mutating command.

| Field | Type | Constraints |
|-------|------|-------------|
| `schemaVersion` | literal | `skillwire.operation/v1`. |
| `operationId` | UUID | Unique. |
| `installationId` | UUID | Target installation. |
| `command` | enum | Mutating command, including `maintenance rotate-service-secret`, and normalized arguments without secrets. |
| `previewHash` | SHA-256 | Canonical preview bound to confirmation. |
| `confirmation` | record | Interactive/non-interactive method, timestamp, and confirmed scope; no terminal input content. |
| `releaseBefore` / `releaseTarget` | optional string | Upgrade/setup identities. |
| `steps` | ordered array | Intent, component, before identity, expected after identity, disposition, compensation, timestamps. |
| `rollbackBoundary` | enum | `automatic`, `client-only`, `application-config`, `database-restore-required`, `none`. |
| `state` | enum | `previewed`, `confirmed`, `running`, `compensating`, `completed`, `incomplete`, `cancelled`, `recovery-required`, `failed`. |
| `finalSummary` | record | Redacted component results and safe next actions. |

Per-step protocol:

```text
intent-prepared-and-synced
  -> mutation-attempted
  -> observed-and-verified
  -> committed-and-synced

mutation failure
  -> compensation-intent-synced
  -> narrow compensation attempted
  -> restored-and-synced | recovery-required
```

Only `completed` can represent full success. `incomplete` is the non-success outcome used for dual-client partial failure with retained verified work.

## 9. Backup Set

Protected, restore-validated recovery material.

| Field | Type | Constraints |
|-------|------|-------------|
| `backupId` | UUID | Stable identity. |
| `installationId` | UUID | Source installation. |
| `createdAt` | timestamp | UTC. |
| `sourceReleaseId` | string | Active verified release. |
| `schemaIdentity` | record | Applied migration list/checksums and forward-only boundary. |
| `databaseArchive` | record | Custom-format dump relative path, size, SHA-256, mode `0600`. |
| `recoveryManifest` | record | Owned configuration/ownership/catalog/advisory/Compose identities plus client-credential and service-secret references; no raw secret. |
| `validation` | record | Isolated PostgreSQL image/digest, restore result, invariant results, readiness result, validation timestamp. |
| `state` | enum | `creating`, `hashed`, `restoring`, `valid`, `invalid`, `retained`, `removed`. |

```text
creating -> hashed -> restoring -> valid
    \          \          \-----> invalid
     \----------\----------------> invalid
```

A backup is never `valid` until an isolated restore and application integrity/readiness checks pass. Missing retained secrets are a recovery finding, not a reason to include them in the archive. Restore instructions warn that the restored data may reintroduce repository memory erased after the backup timestamp.

## 10. Diagnostic Finding

Stable, redacted evidence from preflight, status, doctor, verification, or recovery.

| Field | Type | Constraints |
|-------|------|-------------|
| `code` | stable string enum | One documented code per failure layer. |
| `severity` | enum | `info`, `warning`, `error`, `recovery-required`. |
| `component` | enum | `release`, `trust-policy`, `signing`, `dispatcher`, `filesystem`, `docker`, `postgres`, `migration`, `catalog`, `advisory`, `service-secret`, `credential`, `bridge`, `codex`, `claude`, `mcp-contract`, `activation`, `source`, `backup`, `journal`. |
| `summary` | bounded string | No secret, prompt, response, account ID, repository hash, or unrelated profile content. |
| `evidence` | bounded structured record | Categorical/version/hash/status values and redacted owned paths only. |
| `nextAction` | bounded string | Safe, non-destructive next step. |

At minimum the code set distinguishes every FR-061 class plus release integrity, ownership ambiguity, concurrent mutation, remote Docker context, backup invalidity, and rollback/restore requirements.

## 11. Deterministic Client Verification and Automatic Diagnostic

### Deterministic Client Verification

| Field | Type | Constraints |
|-------|------|-------------|
| `verificationId` | UUID | Per fresh process. |
| `client` / `clientVersion` | identity | Must match certified release matrix. |
| `profileIdentity` | SHA-256 | Redacted effective-profile evidence. |
| `credentialReferenceId` | UUID | Reference only. |
| `toolNames` | ordered set | Exactly the six existing names, no extra/missing tool. |
| `contractSha256` | SHA-256 | Canonical schemas/descriptions/annotations/instructions. |
| `journey` | ordered safe trace | `search_skills` then exact returned `load_skill`, then optional fixture-required declared resource. |
| `provenanceCheck` / `advisoryCheck` | boolean | Both true for success. |
| `result` | enum | `passed` or categorized failure. |

### Automatic Activation Diagnostic

References the same release/client/profile but stores the Feature 003 privacy-safe trace and metrics separately. `not-invoked` never changes deterministic `passed`; autonomous release claims require the applicable attributable threshold and cannot be inferred from final prose.

## 12. Bootstrap Source Choice

| Field | Type | Constraints |
|-------|------|-------------|
| `sourceChoiceId` | UUID | Operation-local. |
| `source` | enum | `mattpocock/skills` or `obra/superpowers`. |
| `selected` | boolean | False unless explicitly opted in. |
| `credentialReferenceId` | optional UUID | Separate read-only GitHub credential; never a client key. |
| `registrationIdentity` | optional existing source ID | Created only through existing fixed-origin administration. |
| `syncState` | enum | `not-selected`, `registered`, `verifying`, `eligible`, `quarantined`, `degraded`, `failed`. |

No choice changes first-party catalog identity or service readiness. Eligibility continues to derive only from the existing verification/classification/advisory pipeline.

## Relationships

```text
Trust Policy 1 ─────────── * Release Manifest ───────── * Installed Release
                                  │
SkillWire Installation 1 ──────── 1 active Installed Release
          │
          ├── 1 Installation Ownership Record ── * Owned Asset
          ├── 1 Service Secret Set
          ├── * Operation Journal ─────────────── * Profile Snapshot
          ├── 0..2 Client Integration
          │          ├── 0..1 Credential Reference
          │          ├── 0..* External Integration Dependency
          │          ├── * Deterministic Client Verification
          │          └── * Automatic Activation Diagnostic
          ├── * Backup Set
          ├── * Diagnostic Finding
          └── * Bootstrap Source Choice ───────── existing External Source
```

## Persistence Impact

- **PostgreSQL migrations**: none. Existing migrations 001-010 remain byte-identical and authoritative.
- **XDG config**: non-secret user choices and endpoint configuration.
- **XDG data**: immutable releases, production Compose, plugins/marketplaces, versioned trust material, backups, dedicated database/application secret files, and explicitly accepted fallback client-credential files.
- **XDG state**: installation, ownership, journal, snapshot, and diagnostic/evidence metadata.
- **XDG cache**: verified downloads only; never authoritative or secret.
- **XDG runtime**: locks, FIFOs, and transient staging only; never the sole journal or persistent credential.
- **Client profiles**: only vendor-managed user-scope MCP/plugin/marketplace deltas. No repository profile or catalog-skill content.
