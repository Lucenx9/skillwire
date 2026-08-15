# Research: Self-Hosted Onboarding and Native Client Integration

Research was consolidated on 2026-08-13 from current primary vendor documentation, executable help from the pinned/local client versions, and the existing repository. All planning unknowns are resolved.

## 1. Ship an immutable user-scoped release, not a repository build

**Decision**: Publish separate `linux-amd64` and `linux-arm64` release archives containing the bundled TypeScript application, a pinned Node 24 runtime, a stable `skillwire` launcher/bridge entry point, production Compose, client marketplaces/plugins, and catalog/advisory/migrations. Publish each archive beside its external canonical release manifest, Sigstore bundle, and versioned trust policy as defined in Decision 15. Install immutable versions below `$XDG_DATA_HOME/skillwire/releases/<release-id>/`, expose a SkillWire-owned stable executable below `~/.local/bin`, and atomically select the active release. Production Compose uses only canonical `name@sha256:...` images, `--no-build`, a stable project/volume identity, loopback SkillWire publishing, no PostgreSQL host port, and the existing non-root application restrictions.

**Rationale**: The current `compose.yaml` already has the correct PostgreSQL isolation, loopback app port, one-shot migration, readiness, named volume, secrets, and non-root app behavior, but its `build:` entries and `skillwire:local` tag are development inputs. Docker documents image-by-digest deployment, Compose dependency gates, secrets, rootless operation, and the risks of loading untrusted Compose file references. A bundled Node runtime avoids requiring a host Node installation and avoids Node 24 single-executable tooling that remains in active development.

**Alternatives considered**:

- Build the checkout during setup: rejected because repository contents are mutable and untrusted.
- Mutable tags or `latest`: rejected because they cannot establish release identity or reliable rollback.
- Install Docker or switch daemon ownership/context: rejected because system administration is outside this workflow.
- Remote Docker contexts: rejected because loopback, volume, and user-ownership assumptions would no longer refer to the onboarding host.

**Evidence**: [Docker Compose services](https://docs.docker.com/reference/compose-file/services/), [Compose trust model](https://docs.docker.com/compose/trust-model/), [Docker rootless mode](https://docs.docker.com/engine/security/rootless/), [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/), existing [`compose.yaml`](../../compose.yaml) and [`Dockerfile`](../../Dockerfile).

## 2. Use durable intent-before-effect journals and ownership proofs

**Decision**: Serialize every mutating operation per installation. Persist and sync a `PREPARED` journal step before each narrow mutation, verify the resulting state, then persist the committed step. Each step records non-secret before/after identities and a compensation action. Installation ownership records claim only exact paths, plugin/MCP identities, credentials, containers, volumes, and backups created by SkillWire. An equivalent pre-existing component is recorded as an external dependency and never converted to owned state. A non-equivalent or ambiguous component blocks only that client and requires external resolution; SkillWire never adopts, renames, overwrites, disables, or removes it. Client transactions compensate independently, so one blocked client cannot roll back another verified client or the healthy service.

**Rationale**: Atomic rename protects one replacement but does not make a multi-system operation transactional. A durable journal makes recovery after `SIGKILL` decidable. Narrow ownership proofs are required to distinguish SkillWire-created state from similar user state and prevent broad snapshot restore or uninstall.

**Alternatives considered**:

- In-memory rollback stacks: rejected because interruption destroys the recovery plan.
- Whole-profile restore on any failure: rejected because it can overwrite concurrent unrelated user changes.
- Time-only stale locks: rejected because a slow live operation could be mistaken for a dead process.
- Edit one mutable release directory: rejected because it destroys rollback evidence.

## 3. Use Secret Service through `secret-tool`, with an explicit restrictive-file fallback

**Decision**: Prefer the distro-supported absolute `/usr/bin/secret-tool` executable. Validate it as a trusted regular executable and prove the session service with a uniquely attributed store/read/clear probe. Pass only non-secret attributes in argv (`application=skillwire`, schema, installation UUID, client, credential-reference UUID), send tokens through stdin, capture lookup through a bounded private stdout pipe, and redact bounded stderr. Resolve once per bridge process. If unavailable, show the exact fallback path and risk and require confirmation before creating separate `$XDG_DATA_HOME/skillwire/credentials/<installation-id>/<client>.key` files with owned `0700` ancestors and exact `0600` regular files. In addition to fake-helper unit tests, run integration tests inside an isolated `dbus-run-session` with a real Secret Service implementation and `/usr/bin/secret-tool`; exercise available, locked, unavailable, fresh-process, session-restart/logout simulation, and file-fallback states. A host reboot is simulated by destroying all runtime/session processes and directories while retaining only the persistent XDG data state, then launching a new session and client process.

**Rationale**: The Secret Service API is the interoperable login-session credential interface, and libsecret's tool has the needed stdin/stdout contract without a native Node add-on. Secret Service attributes are explicitly non-secret. The XDG runtime directory disappears at logout and reboot, so persistent fallback credentials belong under the data root, while ownership/journal state belongs under the state root.

**Alternatives considered**:

- Bearer keys in client config, static headers, argv, or environment: rejected by the disclosure boundary and normal desktop/reboot requirements.
- A pure TypeScript Secret Service/D-Bus crypto implementation: rejected as a much larger security and compatibility surface.
- `keytar` or another native keyring dependency: rejected as unnecessary native supply-chain/build scope.
- Silent fallback or package installation: rejected because the user must understand and approve the weaker protection.

**Evidence**: [Secret Service API](https://specifications.freedesktop.org/secret-service/latest-single/), [libsecret](https://gnome.pages.gitlab.gnome.org/libsecret/), [Debian secret-tool manual](https://manpages.debian.org/bookworm/libsecret-tools/secret-tool.1.en.html), [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/).

## 4. Create client keys through a private one-shot channel

**Decision**: Extend the existing authentication administration path so a newly created token is written only to a validated private FIFO/file descriptor below `XDG_RUNTIME_DIR`, bind-mounted into a one-shot administration container with Docker logging disabled. Normal stdout returns non-secret key/account metadata only. The onboarding process reads the token directly into a bounded buffer, stores it immediately, clears the buffer where possible, and revokes the key if persistence or that client's transaction fails.

**Rationale**: [`src/authentication/admin-cli.ts`](../../src/authentication/admin-cli.ts) currently returns the token in stdout JSON. Calling that contract from onboarding risks terminal/container-log capture. The service database is intentionally not host-published, so a private channel into a one-shot container preserves the network boundary without placing the token in arguments, environment, or logs.

**Alternatives considered**:

- Parse the current stdout token: rejected because the current output is unsafe for a supported onboarding guarantee.
- Add a bootstrap HTTP administration endpoint: rejected because it creates a new remotely reachable security surface and bootstrap-auth problem.
- Publish PostgreSQL to the host and create keys locally: rejected because it weakens the deployment boundary.

## 5. Bridge user-scoped STDIO to the existing authenticated HTTP MCP service

**Decision**: Register the stable command `skillwire bridge --installation <uuid> --client codex|claude`. The bridge loads the non-secret endpoint/backend/reference from owned installation state, retrieves exactly one client key, refuses non-loopback endpoints or redirects, creates one authenticated Streamable HTTP upstream connection, validates the exact six tool names/contracts and server instructions, and exposes them over STDIO. It forwards calls and safe errors without adding operations, catalog behavior, memory, ranking, retries, prompts, or persistent state. Missing credential, timeout, 401, upstream mismatch, and transport failure are distinct redacted exit findings.

**Rationale**: Both clients natively launch STDIO MCP servers, while direct HTTP bearer configuration requires a static value or environment plumbing. The bridge is a transport adapter around the protocol-independent service and works from ordinary terminal, IDE, and local desktop launches without shell initialization.

**Alternatives considered**:

- Direct HTTP plus an environment-variable reference: rejected because persistent secure delivery is not guaranteed across launch surfaces.
- A client wrapper: rejected because users must continue to launch ordinary `codex` and `claude`.
- A second MCP implementation with copied tool behavior: rejected because it would fork the six-tool contract and core semantics.

**Evidence**: [Codex MCP documentation](https://developers.openai.com/codex/mcp/), [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp), installed MCP SDK 2.0.0 packages.

## 6. Reconcile Codex through its user configuration and plugin manager

**Decision**: Preflight with `codex mcp list --json` and `codex mcp get skillwire --json`; never call `mcp add` for an existing name because Codex 0.147.0 can replace it. Reuse a verified equivalent entry as external state, block conflicts/duplicates, or add the absent STDIO entry through `codex mcp add skillwire -- <bridge command>`. Leave `required` absent/false. Install the existing `skillwire-autonomous-activation` identity from a release-local immutable marketplace through `codex plugin marketplace add` and `codex plugin add`. Preserve Feature 003's exact three-file package contract, including its credential-free SkillWire dependency metadata, instruction policy, and remote-content exclusions. Treat that declaration as adapter metadata rather than evidence of effective client configuration: Feature 004 owns or reuses the independently verified named STDIO registration and must prove through real manager/profile inspection that plugin lifecycle operations neither replace it nor create a second connection.

**Rationale**: Codex stores user MCP configuration in `~/.codex/config.toml`, shared by CLI, IDE, and desktop on the same host. STDIO and user plugin lifecycles are supported. `required=true` explicitly fails startup. Disposable probing confirmed unrelated TOML/comments are preserved but same-name add is destructive. Preserving the existing package is necessary for FR-090's unchanged Feature 003 invariants; correctness therefore comes from reconciling the actual named MCP registration before plugin installation and checking it again afterward. The current Feature 003 harness synthesizes an effective `skillwire` inventory item whenever the plugin is present, so Feature 004 adds a real manager/profile assertion instead of relying on that abstraction.

**Alternatives considered**:

- Direct TOML editing: rejected in favor of the vendor CLI.
- Repository `.codex/config.toml` or user skill copying: rejected by scope and lifecycle requirements.
- Remove or rewrite the existing package dependency: rejected because it would invalidate Feature 003's exact package contract. Feature 004 instead separates immutable adapter metadata from the actual, independently reconciled STDIO registration.
- Require the MCP server: rejected because SkillWire is optional augmentation.

**Evidence**: [Codex MCP](https://developers.openai.com/codex/mcp/), [Codex skills](https://developers.openai.com/codex/skills/), [Codex plugins](https://developers.openai.com/codex/plugins/), existing [Codex adapter](../../integrations/codex/skillwire-autonomous-activation/) and [manager harness](../../tests/helpers/codex-plugin-manager-harness.ts).

## 7. Certify Claude Code 2.1.229 and use only its user-scope lifecycle

**Decision**: The first Feature 004 release certifies Claude Code 2.1.229, not 2.0.13. Always use explicit user scope: `claude mcp add --transport stdio --scope user skillwire -- <bridge command>`, plus release-local `claude plugin marketplace add --scope user`, `plugin install --scope user`, and scoped enable/disable/update/uninstall commands. The minimal Claude activation plugin contains the bounded Feature 003 policy and no MCP declaration, hooks, executable payload, credential, or catalog content. Inspect local/project/user precedence and managed policy before mutation; a shadowing higher-precedence entry blocks success.

**Rationale**: User MCP state lives in `~/.claude.json` and user plugin preference in the normal Claude profile. Current Claude exposes non-interactive user-scope lifecycle commands. Executable probing of 2.0.13 found only `plugin validate`; its install lifecycle was interactive, which cannot support the required deterministic preview/rollback workflow. Version 2.1.229 satisfies the specification's “2.0.13 or later explicitly certified” boundary and exposes the required supported commands.

**Alternatives considered**:

- Automate the 2.0.13 interactive `/plugin` UI: rejected as brittle and unsupported.
- Synthesize Claude's plugin cache/settings: rejected because it bypasses the manager.
- Plugin-provided MCP plus user MCP: rejected because it creates duplicate ownership and precedence ambiguity.
- Alternate `CLAUDE_CONFIG_DIR`, wrapper, or repository config: rejected because they are not the normal user profile.

**Evidence**: [Claude MCP](https://code.claude.com/docs/en/mcp), [plugin reference](https://code.claude.com/docs/en/plugins-reference), [plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [settings](https://code.claude.com/docs/en/settings), and executable help from Claude Code 2.1.229.

## 8. Treat vendor CLIs as narrow mutation interfaces, not transaction managers

**Decision**: Before any client mutation, capture secure profile identities/snapshots, effective inventories, managed-policy results, and the intended structured delta. Invoke vendor commands with `shell:false`, sanitized environments, absolute executables, deadlines, bounded output, and no secret values. Afterward, prove the expected SkillWire delta and semantically unchanged unrelated state. On failure use the scoped inverse command; restore a whole-file snapshot only if the current file still exactly matches the expected installer post-image. Uninstall invokes a remove command only when both ownership proof and current normalized identity match.

**Rationale**: Vendor CLIs preserve their own formats better than direct editing, but neither protects the multi-step SkillWire transaction or external concurrent changes. Codex preserves comments in the certified probe; Claude JSON management does not promise byte preservation, so tests compare semantic unrelated state and byte equality only where the vendor preserves it.

**Alternatives considered**:

- Blind idempotent `add`: rejected because same-name behavior can overwrite or error.
- Blind full snapshot restore: rejected because it can destroy concurrent user changes.
- Unscoped remove/uninstall: rejected because it can target the wrong precedence layer.

## 9. Separate deterministic setup gates from automatic-activation evidence

**Decision**: For each selected client, start a fresh ordinary process and require authenticated initialization, exact six-tool discovery, and a scripted `search_skills` to exact previewed `load_skill` journey with provenance/advisory checks and at most the fixture-required declared resource read. Record automatic activation from a separate fresh session and never let non-activation roll back a deterministically verified client. Maintain separate Codex and Claude release evidence and withhold autonomous claims until the Feature 003 threshold is met.

**Rationale**: Tool connectivity and schemas are deterministic; model selection of an optional skill is not. This preserves the clarified acceptance boundary and Feature 003's honest evidence model.

**Alternatives considered**:

- Gate setup on spontaneous model invocation: rejected because it is stochastic and unrelated to transport correctness.
- Use a mocked inventory: rejected because the current Codex harness has a gap where it synthesizes `skillwire` rather than proving a real registration.
- Accept a healthy HTTP endpoint without client launch: rejected because it does not test the normal profile or credential bridge.

## 10. Use restore-validated PostgreSQL logical backups and schema-aware upgrade

**Decision**: Stream `pg_dump -Fc` from the release-pinned PostgreSQL image into an exclusive `0600` backup file and record non-secret recovery metadata/checksums. Restore every candidate backup into an isolated, unpublished PostgreSQL 17.10 volume with `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`; then verify migration versions/checksums, representative data, catalog/advisory integrity, and readiness before marking it valid. Do not copy raw keys, database password, pepper, GitHub token, or unrelated profile data. Backup metadata records secret references and restore reports missing retained secrets as a rotation/recovery requirement.

For upgrades, verify the target release before stopping anything. Drain all writers for forward-only boundaries, validate the backup before migration, run the existing checksum/advisory-lock migration gate, and query live `schema_migrations`. Before migration 010, application/config rollback is allowed when the target manifest declares compatibility. After 010, refuse a pre-010 image-only rollback and keep writers stopped until a compatible release or explicit validated restore is selected.

**Rationale**: PostgreSQL documents that logical dumps are internally consistent and architecture-portable, custom format uses `pg_restore`, and cluster-wide role data is separate. A checksum alone proves bytes, not restorability. Existing application migrations already detect checksum drift and newer schemas.

**Alternatives considered**:

- Copy the live volume: rejected as version-specific and difficult to validate safely across architectures.
- Mark a dump valid after hashing/listing: rejected because it does not prove restore.
- Include raw secrets for convenience: rejected by the secret-leak success criterion.
- Image-only rollback after migration 010: rejected as schema-incompatible.

**Evidence**: [PostgreSQL 17 SQL dump](https://www.postgresql.org/docs/17/backup-dump.html), [PostgreSQL 17 upgrading](https://www.postgresql.org/docs/17/upgrading.html), existing [migration runner](../../src/persistence/postgres/migration-runner.ts) and [operations guide](../../docs/operations.md).

## 11. Keep catalog bootstrap on existing trust paths

**Decision**: Validate and expose the ten bundled first-party launch skills entirely from the release with GitHub network disabled. Offer `mattpocock/skills` and `obra/superpowers` only as explicit choices after service readiness. Registration invokes the existing fixed-origin source administration and ingestion/quarantine pipeline with a separately stored read-only GitHub credential. Source failure produces a degraded finding but does not affect readiness or cached eligible content.

**Rationale**: The repository already contains the immutable ten-skill release and the verified external-source pipeline. Onboarding needs orchestration, not a parallel trust or import mechanism.

**Alternatives considered**:

- Fetch first-party skills during setup: rejected because it makes baseline availability depend on GitHub.
- Automatically register curated sources: rejected because curated is not equivalent to trusted first-party content.
- Install imported skills into clients: rejected by the constitution.

## 12. Add no production database schema for onboarding state

**Decision**: Keep installation, ownership, journal, snapshot, backup, and client-integration metadata in restrictive versioned JSON under the user's XDG state/data roots. Continue to use existing PostgreSQL tables for account/key, repository memory, catalog, external source, and audit state. No migration 011 is planned.

**Rationale**: Lifecycle recovery must be available when PostgreSQL is stopped or broken, and the entities describe host/client state rather than service-domain data. Avoiding an onboarding database dependency also keeps `doctor`, restore, and uninstall operable during service failure.

**Alternatives considered**:

- Store ownership/journals only in PostgreSQL: rejected because the tool could not safely diagnose or repair PostgreSQL-unavailable states.
- Store account or repository memory in XDG files: rejected because it would fork existing tenant-scoped authoritative persistence.

## 13. Generate and retain service secrets in a dedicated boundary

**Decision**: Implement database and application secret lifecycle only in `src/onboarding/secrets/service-secrets.ts`. Generate each secret independently with the Node cryptographic random source at a minimum of 256 bits, encode without reducing entropy, and persist it through exclusive create-only files under `$XDG_DATA_HOME/skillwire/installations/<installation-id>/secrets/`. Every owned directory is UID-owned mode `0700`; every final regular file is UID-owned mode exactly `0600`, link count one, and opened/revalidated without following links. Creation syncs each file and its directory before state can advance. A valid existing secret is reused byte-for-byte by setup/repair/upgrade; an invalid owner, mode, type, link, size, or location is a blocking finding rather than an automatic rewrite.

Automatic setup and repair never rotate service secrets. Rotation is a separate maintenance operation with a preview naming the affected service, a retained prior secret until the replacement service passes readiness, and an application/config rollback boundary. Raw values never enter argv, environment diagnostics, stdout/stderr, logs, reports, journals, backup metadata, test source, or canary evidence; Compose consumes only the restrictive files. Backup metadata stores secret references and identities, not values.

**Rationale**: Client key storage does not cover PostgreSQL passwords or the application API-key pepper. A dedicated component makes FR-009 testable and keeps service-secret ownership, validation, idempotence, rotation, and disclosure rules out of broad setup orchestration.

**Alternatives considered**:

- Reuse the client credential backend: rejected because service containers need restrictive file mounts and have a different rotation/retention boundary.
- Put secrets in Compose environment or generated YAML: rejected because config rendering and process inspection can disclose them.
- Repair permissions or replace an unsafe existing secret automatically: rejected because ownership is ambiguous and an unnoticed rotation can make data unavailable.

## 14. Use one real dispatcher for administrative and bridge modes

**Decision**: `src/onboarding/cli/main.ts` is the sole executable dispatcher behind the package and distributed `bin/skillwire` launcher. It parses argv exactly once, chooses either internal `bridge` mode or the administrative router, and dispatches setup, read-only inspection, client lifecycle, repair, backup, upgrade, uninstall, purge, and explicit maintenance operations. Bridge mode bypasses ordinary administrative previews/progress/rendering so stdout remains exclusively MCP STDIO. Administrative JSON mode emits one JSON document on stdout; human diagnostics/progress use stderr. Domain failures map once to the documented exit codes.

The dispatcher installs bounded `SIGINT` and `SIGTERM` handlers, aborts the shared cancellation signal, allows journaled operations to reach only their documented safe cancellation boundary, and exits without printing credentials. Tests invoke the compiled entry point to prove argv rejection, every dispatch route, JSON stdout purity, human stderr separation, signal propagation, exit-code mapping, bridge byte routing, and no wrapper/alternate-profile behavior.

**Rationale**: Package scripts and command routers do not themselves prove that the shipped executable reaches every command or that bridge traffic bypasses administrative output. A single dispatcher makes those process-level contracts observable.

**Alternatives considered**:

- Separate wrapper executables: rejected because ordinary client registrations and users must use the one stable `skillwire` executable.
- Let every command install its own signal/exit handlers: rejected because it creates inconsistent cancellation and output behavior.

## 15. Sign canonical manifests with Cosign keyless GitHub OIDC and verify offline

**Decision**: Pin Cosign `3.1.3`, the current release on 2026-08-13 and the first selected version containing the latest legacy-bundle verification-bypass fix. Obtain each build/verifier binary only from the exact `sigstore/cosign` v3.1.3 GitHub release and verify it through Sigstore's official TUF `artifact.pub` flow plus the corresponding official Cosign release bundle before recording its per-platform SHA-256 in the release-tool lock. Do not use `latest`, an unverified action download, or a long-lived signing key.

Each platform normally publishes four sibling assets: `skillwire-<release>-linux-<arch>.tar.zst`, `skillwire-<release>-linux-<arch>.release.json`, `skillwire-<release>-linux-<arch>.release.sigstore.json`, and `skillwire-trust-policy-v<sequence>.json`. A signer-overlap release additionally publishes `skillwire-<release>-linux-<arch>.release.<new-signer-id>.sigstore.json`, and the manifest enumerates both exact ordered bundle filenames and signer identities; each bundle independently binds the canonical manifest digest and the verifier hashes bundle bytes to reject duplicate evidence. Bundle digests cannot be manifest fields because the bundles sign that manifest, which would create a circular hash dependency. The overlap bundle is the sole exception to the normal four-asset set. The release JSON is UTF-8 RFC 8785 JSON Canonicalization Scheme output with no BOM and no trailing newline. It uses `skillwire.release/v1`, includes a monotonic `releaseSequence`, the archive byte size/SHA-256, the complete extracted payload inventory and identities, exact image/platform digests, catalog/advisory/migration/adapter hashes, the Feature 003 `distribution/codex-marketplace/release-integrity.json` identity, compatibility, and the required trust-policy version/hash. Because the manifest is outside the archive, it can bind the archive without a circular digest.

The protected tag workflow `.github/workflows/self-hosted-release.yml` accepts only the annotated `self-hosted-v<package.version>` tag, recursively peels it to the exact workflow SHA, proves the target is reachable from protected `main`, and checks package/manifest/source identity before signing. It builds and verifies before signing, grants only `contents: read` and `id-token: write`, and invokes `cosign sign-blob --yes --timeout 2m --oidc-provider github-actions --signing-algorithm ecdsa-sha2-256-nistp256 --bundle <manifest>.sigstore.json <canonical-manifest>`. Cosign 3 emits canonical proto3 JSON Sigstore Bundle media type `application/vnd.dev.sigstore.bundle.v0.3+json`, containing the message signature, Fulcio certificate, signed timestamp, and transparency-log proof. The expected OIDC issuer is exactly `https://token.actions.githubusercontent.com`; the exact certificate identity is `https://github.com/Lucenx9/skillwire/.github/workflows/self-hosted-release.yml@refs/tags/self-hosted-v<release-id>`. Verification also pins repository `Lucenx9/skillwire`, workflow ref, tag ref, and exact workflow commit SHA claims. Signing failure or missing transparency material fails publication.

Bootstrap uses an independently verified Cosign 3.1.3 and a locally supplied Sigstore TrustedRoot JSON with exact media type `application/vnd.dev.sigstore.trustedroot+json;version=0.1` acquired through Sigstore TUF. Cosign 3.1.3 pins `sigstore-go` 1.2.2, whose loader accepts only that value; the conflicting `application/vnd.dev.sigstore.trustedroot.v0.2+json` value described by the newer protobuf specification is unsupported by this pinned verifier and fails closed. With outbound network blocked, bootstrap directly runs `cosign verify-blob --timeout 30s --bundle <bundle> --trusted-root <root> --certificate-identity <exact-workflow-tag-URI> --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-github-workflow-repository Lucenx9/skillwire --certificate-github-workflow-ref refs/tags/self-hosted-v<release-id> --certificate-github-workflow-sha <exact-tag-commit> <canonical-manifest>`. It never uses the insecure SCT/tlog bypasses or identity/issuer regular expressions, then independently validates bundle media type/evidence, policy sequences/deny set, canonical manifest, and archive digest before extraction or execution. After safe extraction, `skillwire` repeats verification using the release-pinned verifier and installed policy before any mutation. No verification path performs an unbounded transparency lookup or silently refreshes trust; a missing/stale trusted root yields exact instructions for an explicit bounded TUF refresh before retry.

`skillwire.trust-policy/v1` is a canonical, versioned policy containing a monotonic policy sequence, accepted exact signer identities/claims, issuer, workflow, tag form, trusted-root media type/hash, Cosign version/hash set, minimum release sequence, denied manifest/certificate identities or digests, and validity window. The first policy is pinned in source/distribution documentation and embedded in the verified installer. For an update, the active installed policy first verifies the release manifest; the manifest's signed next-policy hash then authenticates that policy before it can become active. A policy/identity rotation release must be accepted under the old policy and carry the separately named valid bundles from both the old and proposed signer during at least one published overlap release; only a later old-policy-authorized update may remove the old signer. Emergency revocation is an old-policy-authorized policy update adding the compromised identity/certificate/manifest digest to the deny set. If no trusted signer survives, automatic update stops and recovery requires a separately authenticated out-of-band trust bootstrap. Offline verification cannot discover later revocation, so every new install/upgrade must use the latest explicitly refreshed policy; cached verification remains scoped to its recorded policy sequence.

Install state records the highest accepted policy and release sequences. Setup/upgrade rejects a lower sequence, an unknown policy, a changed policy hash, missing overlap proof, wrong issuer/identity/repository/workflow/ref/SHA, invalid/legacy bundle media type, absent/invalid transparency or timestamp evidence, archive/manifest digest mismatch, revoked material, and any signature failure before extraction or mutation. An explicit database restore may select compatible data but never lowers the executable/trust policy automatically.

**Rationale**: Sigstore documents keyless GitHub Actions signing, exact issuer/identity verification, bundle-contained signatures/certificates/log proofs, v0.3 bundle serialization, TUF-distributed trusted roots, and offline verification from a supplied trusted root. Cosign 3.1.3 fixes the current verification bypass. Signing an external canonical manifest binds both archive bytes and all extracted identities without a circular archive hash and avoids repository-held private keys.

**Alternatives considered**:

- Repository-held Ed25519 or PGP private key: rejected because it creates long-lived secret custody and rotation scope.
- Online-only Rekor lookup: rejected because setup must remain deterministic and usable with bounded/offline verification material.
- Trust any GitHub Actions certificate from the repository: rejected because workflow, tag, SHA, issuer, and certificate identity must all match.
- Put the archive digest inside a manifest embedded in that archive: rejected because it creates a circular digest.

**Evidence**: [Sigstore CI quickstart](https://docs.sigstore.dev/quickstart/quickstart-ci/), [Sigstore bundle format](https://docs.sigstore.dev/about/bundle/), [Cosign 3.1.3 signing reference](https://github.com/sigstore/cosign/blob/v3.1.3/doc/cosign_sign-blob.md), [Cosign 3.1.3 verification reference](https://github.com/sigstore/cosign/blob/v3.1.3/doc/cosign_verify-blob.md), [Cosign 3.1.3 dependency pin](https://github.com/sigstore/cosign/blob/v3.1.3/go.mod), [sigstore-go 1.2.2 TrustedRoot loader](https://github.com/sigstore/sigstore-go/blob/v1.2.2/pkg/root/trusted_root.go), [Sigstore protobuf TrustedRoot media-type contract](https://github.com/sigstore/protobuf-specs/blob/v0.5.1/protos/sigstore_trustroot.proto), [Cosign installation and release verification](https://docs.sigstore.dev/cosign/system_config/installation/), [Cosign 3.1.3 release](https://github.com/sigstore/cosign/releases/tag/v3.1.3), [GitHub Actions OIDC claims](https://docs.github.com/en/actions/reference/security/oidc).

## 16. Separate deterministic timing and real-session evidence from usability claims

**Decision**: Contract tests use a monotonic clock and fault-controlled helpers to prove the entire bridge path—state validation, credential lookup, upstream initialization, contract validation, and STDIO readiness—finishes or cancels within 10 seconds, with tighter internal budgets whose total cannot exceed the client budget. CI records clean-host setup elapsed time as informational evidence and fails only deterministic functional/deadline contracts; the 15-minute and 95% participant outcome remains a moderated usability acceptance measure. Secret Service evidence includes both fake helper unit tests and a real isolated Linux D-Bus/keyring job. Session restart destroys D-Bus, keyring daemon, runtime state, and client process, then starts a fresh session against retained persistent state; this is the deterministic CI proxy for logout/reboot, with a manual supported-host reboot smoke remaining consent-gated.

**Rationale**: Deterministic deadlines can gate CI, while human completion distributions require participant evidence. A real implementation catches D-Bus/keyring integration errors that a fake `secret-tool` cannot, and session reconstruction tests persistent delivery without pretending a container restart is a physical reboot.

**Alternatives considered**:

- Make the 15-minute participant outcome a standard CI threshold: rejected because it does not measure user completion.
- Treat a fake helper as sufficient Secret Service evidence: rejected because it cannot prove session-bus and collection behavior.

## Certified implementation baseline

| Component | Initial certification target | Planning consequence |
|-----------|------------------------------|----------------------|
| Node runtime | 24.18.x, exact patch/digest in release | Bundled per architecture; host Node not required. |
| Docker Engine | 29.7.2 and compatible 29.x | Preflight only; no install/daemon mutation. |
| Docker Compose | 5.4.0 and compatible 5.x | Production file uses no local build. |
| PostgreSQL image | 17.10 exact multi-arch digest | Backup/restore clients use the same release image. |
| Codex CLI | 0.147.0 | JSON MCP/plugin lifecycle and comment preservation are contract-tested. |
| Claude Code | 2.1.229 | 2.0.13 is rejected because it lacks the required non-interactive plugin lifecycle. |
| Cosign | 3.1.3 | Exact verified release binary; Sigstore Bundle v0.3 keyless signing and local TrustedRoot verification only. |

Certification never generalizes to untested versions; later versions require the same command-shape, profile-preservation, bridge, failure, and release evidence.
