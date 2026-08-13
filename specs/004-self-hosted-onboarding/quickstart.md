# Quickstart: Validate Self-Hosted Onboarding and Native Client Integration

This is the post-implementation validation guide. It uses only disposable user profiles and a disposable empty repository. Do not point it at a real Codex/Claude profile. The normative interfaces are [administrative-cli.md](./contracts/administrative-cli.md), [credential-bridge.md](./contracts/credential-bridge.md), [client-integration.md](./contracts/client-integration.md), [release-and-recovery.md](./contracts/release-and-recovery.md), and [service-secrets.md](./contracts/service-secrets.md).

## Prerequisites

- Linux `amd64` or `arm64` on Ubuntu 24.04 or Debian 12/13
- Local Docker Engine 29.x and Docker Compose 5.x already usable by the current user
- Node.js 24 and pnpm 11.21.0 for source/test work only; the built release bundles its runtime
- Codex CLI 0.147.0 for Codex acceptance
- Claude Code 2.1.229 for Claude acceptance
- independently verified Cosign 3.1.3 and the policy-pinned local Sigstore TrustedRoot for release verification
- `jq`, Git, and enough local disk for one primary and one isolated backup-validation PostgreSQL volume
- Optional `/usr/bin/secret-tool` plus an available Secret Service session; otherwise exercise the disclosed restrictive-file fallback

Confirm prerequisites without changing them:

```bash
docker version
docker compose version
docker context show
codex --version
claude --version
```

Expected: a local rootless or rootful Docker context, Codex `0.147.0`, and Claude `2.1.229`. A remote Docker context, Claude 2.0.13, an unsupported OS/architecture, or a missing Compose capability must be rejected before mutation.

## 1. Prepare disposable user and repository roots

```bash
export SW004_ROOT="$(mktemp -d)"
export SW004_PROFILE="$SW004_ROOT/home"
export SW004_CONFIG="$SW004_PROFILE/.config"
export SW004_DATA="$SW004_PROFILE/.local/share"
export SW004_STATE="$SW004_PROFILE/.local/state"
export SW004_CACHE="$SW004_PROFILE/.cache"
export SW004_RUNTIME="$SW004_ROOT/runtime"
export SW004_REPOSITORY="$SW004_ROOT/empty-repository"

install -d -m 700 \
  "$SW004_PROFILE" "$SW004_CONFIG" "$SW004_DATA" \
  "$SW004_STATE" "$SW004_CACHE" "$SW004_RUNTIME" \
  "$SW004_REPOSITORY"
git -C "$SW004_REPOSITORY" init
git -C "$SW004_REPOSITORY" commit --allow-empty -m fixture
git -C "$SW004_REPOSITORY" status --porcelain=v1 > "$SW004_ROOT/repository-before.txt"
```

Every acceptance command below is launched with this explicit environment:

```text
env HOME="$SW004_PROFILE" \
    XDG_CONFIG_HOME="$SW004_CONFIG" \
    XDG_DATA_HOME="$SW004_DATA" \
    XDG_STATE_HOME="$SW004_STATE" \
    XDG_CACHE_HOME="$SW004_CACHE" \
    XDG_RUNTIME_DIR="$SW004_RUNTIME" \
    <command>
```

This is test isolation, not a supported end-user alternate-profile workflow.

## 2. Run static and deterministic source gates

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm exec prettier --check specs/004-self-hosted-onboarding
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:e2e
pnpm test:evaluation
pnpm test:security
```

The implementation adds a focused aggregate command:

```bash
pnpm test:feature-004
```

Expected: all Feature 004 lifecycle, bridge, client, release, preservation, interruption, backup, upgrade, uninstall, and canary-leak suites pass. Existing Feature 001-003 suites remain green.

The process-level and real-session gates are explicit:

```bash
pnpm exec vitest run --project contract \
  tests/contract/cli/dispatcher.test.ts \
  tests/contract/credential-bridge/end-to-end-deadline.test.ts
pnpm exec vitest run --project integration \
  tests/integration/onboarding/secret-service-session.test.ts \
  tests/integration/onboarding/service-secrets-compose.test.ts
```

Expected: the compiled `skillwire` executable reaches every administrative command and bridge mode, JSON and MCP stdout stay pure, `SIGINT`/`SIGTERM` propagate, every exit maps to the contract, and the entire process-start-to-STDIO-ready/failure path remains within 10.0 seconds by a monotonic clock. The Secret Service job uses real `/usr/bin/secret-tool` inside an isolated D-Bus/keyring session, destroys all runtime/session processes and state, then proves a fresh session can use retained persistent state. A supported-host physical reboot smoke remains manual and consent-gated.

## 3. Build and verify the local release candidate

Build only the platform matching the current fixture:

```bash
pnpm build:self-hosted -- --platform linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
pnpm verify:self-hosted
```

The release job emits exactly four sibling assets for that platform:

```text
skillwire-<release>-linux-<arch>.tar.zst
skillwire-<release>-linux-<arch>.release.json
skillwire-<release>-linux-<arch>.release.sigstore.json
skillwire-trust-policy-v<sequence>.json
```

A signer-rotation overlap release is the documented exception: it also emits `skillwire-<release>-linux-<arch>.release.<new-signer-id>.sigstore.json`, and the signed manifest binds both bundle identities. Verification must accept the release under the active old policy, verify both old/new signer bundles, authenticate the referenced next-policy hash, and only then activate that policy.

Before extracting or running the archive, follow `distribution/self-hosted/README.md`: verify the exact Cosign 3.1.3 binary with Sigstore's official TUF `artifact.pub` and release bundle, match its platform SHA-256 to the policy, then run network-blocked `cosign verify-blob` with the local TrustedRoot, Bundle v0.3 file, issuer `https://token.actions.githubusercontent.com`, and certificate identity `https://github.com/Lucenx9/skillwire/.github/workflows/self-hosted-release.yml@refs/tags/v<release-id>`. The policy also checks repository, workflow ref, tag ref, and exact workflow commit SHA. Never use `latest`, an unverified action download, or `curl | sh`.

Expected release validation:

- the external UTF-8 RFC 8785 canonical manifest has no BOM/trailing newline; its Cosign 3.1.3 Bundle v0.3 verifies offline against the policy-pinned TrustedRoot and exact signer claims;
- manifest/policy/release sequences are non-decreasing, no deny-list item matches, and archive filename/size/SHA-256 match before extraction;
- every file, image digest, Compose definition, catalog/advisory/migration, client plugin, and marketplace identity matches;
- `distribution/codex-marketplace/release-integrity.json` matches the manifest and all unchanged Feature 003 package/evaluation integrity gates pass;
- the archive contains no link, special file, path escape, unlisted byte, credential, or mutable image reference;
- production Compose has no `build`, no PostgreSQL host port, and only the loopback SkillWire port;
- exactly ten first-party release skills and the unchanged six-tool contract are bound.

Set `SW004_RELEASE_BIN` to the verified candidate's `bin/skillwire` entry point and run all later commands from `$SW004_REPOSITORY`.

## 4. Preview and install the service without a client

```bash
env HOME="$SW004_PROFILE" \
  XDG_CONFIG_HOME="$SW004_CONFIG" XDG_DATA_HOME="$SW004_DATA" \
  XDG_STATE_HOME="$SW004_STATE" XDG_CACHE_HOME="$SW004_CACHE" \
  XDG_RUNTIME_DIR="$SW004_RUNTIME" \
  "$SW004_RELEASE_BIN" setup --clients none \
  --preview-only --output json > "$SW004_ROOT/setup-preview.json"

jq -e '
  .schemaVersion == "skillwire.admin-result/v1" and
  .status == "preview" and
  .changed == false and
  (.previewHash | test("^[0-9a-f]{64}$"))
' "$SW004_ROOT/setup-preview.json"
```

Review the preview: it must show release/images, XDG paths, loopback endpoint, containers, stable PostgreSQL volume, secret locations, `clients: none`, exact changes, and retention/rollback information without secret values.

Then confirm that exact preview:

```bash
export SW004_PREVIEW_HASH="$(jq -r '.previewHash' "$SW004_ROOT/setup-preview.json")"

env HOME="$SW004_PROFILE" \
  XDG_CONFIG_HOME="$SW004_CONFIG" XDG_DATA_HOME="$SW004_DATA" \
  XDG_STATE_HOME="$SW004_STATE" XDG_CACHE_HOME="$SW004_CACHE" \
  XDG_RUNTIME_DIR="$SW004_RUNTIME" \
  "$SW004_RELEASE_BIN" setup --clients none \
  --confirm-preview "$SW004_PREVIEW_HASH" --output json \
  > "$SW004_ROOT/setup-result.json"
```

Expected: release installation, PostgreSQL/migration success, liveness and readiness, one account, ten first-party skills, valid catalog/advisory integrity, zero GitHub requests, and no client profile changes. The final status is success with client integration pending.

Also verify that `database-password` and `application-pepper` were independently created beneath `$SW004_DATA/skillwire/installations/<installation-id>/secrets/`, with mode exactly `0600` below UID-owned `0700` directories. Save file identities and canary-safe digests, repeat unchanged setup/repair/upgrade, and prove the exact bytes are reused. Unsafe ownership, mode, type, link count, or location must block without chmod, adoption, regeneration, or rotation.

## 5. Add and verify Codex

Preview then confirm `clients install codex` using the same two-step hash flow. If Secret Service is unavailable, the preview must identify the exact fallback file and risk; exercise that path only after explicit confirmation.

After success:

```bash
env HOME="$SW004_PROFILE" \
  XDG_CONFIG_HOME="$SW004_CONFIG" XDG_DATA_HOME="$SW004_DATA" \
  XDG_STATE_HOME="$SW004_STATE" XDG_CACHE_HOME="$SW004_CACHE" \
  XDG_RUNTIME_DIR="$SW004_RUNTIME" \
  codex mcp get skillwire --json

env HOME="$SW004_PROFILE" \
  XDG_CONFIG_HOME="$SW004_CONFIG" XDG_DATA_HOME="$SW004_DATA" \
  XDG_STATE_HOME="$SW004_STATE" XDG_CACHE_HOME="$SW004_CACHE" \
  XDG_RUNTIME_DIR="$SW004_RUNTIME" \
  codex plugin list --marketplace skillwire --json
```

Expected: one optional user `skillwire` STDIO registration with only the stable bridge command/installation/client selectors; no secret fields or `required=true`; one exact immutable activation plugin. The installation result includes a passing exact-six-tool authenticated discovery and scripted first-party search/exact-load trace. Automatic activation is reported separately and may be `not-invoked` without changing deterministic success.

## 6. Add and verify Claude Code

Preview then confirm `clients install claude`.

```bash
env HOME="$SW004_PROFILE" \
  XDG_CONFIG_HOME="$SW004_CONFIG" XDG_DATA_HOME="$SW004_DATA" \
  XDG_STATE_HOME="$SW004_STATE" XDG_CACHE_HOME="$SW004_CACHE" \
  XDG_RUNTIME_DIR="$SW004_RUNTIME" \
  claude mcp get skillwire

env HOME="$SW004_PROFILE" \
  XDG_CONFIG_HOME="$SW004_CONFIG" XDG_DATA_HOME="$SW004_DATA" \
  XDG_STATE_HOME="$SW004_STATE" XDG_CACHE_HOME="$SW004_CACHE" \
  XDG_RUNTIME_DIR="$SW004_RUNTIME" \
  claude plugin list --json
```

Expected: one user-scoped `skillwire` STDIO bridge entry and one user-scoped instruction-only activation plugin. No `.mcp.json`, repository `.claude`, raw key, header, secret environment, plugin MCP declaration, hook, or executable plugin payload exists. Claude passes the same deterministic six-tool/smoke contract independently of Codex.

## 7. Prove idempotence, status, and doctor

Capture owned/profile/repository digests, then repeat the same `setup --clients codex,claude` ten times using fresh previews.

```bash
env HOME="$SW004_PROFILE" \
  XDG_CONFIG_HOME="$SW004_CONFIG" XDG_DATA_HOME="$SW004_DATA" \
  XDG_STATE_HOME="$SW004_STATE" XDG_CACHE_HOME="$SW004_CACHE" \
  XDG_RUNTIME_DIR="$SW004_RUNTIME" \
  "$SW004_PROFILE/.local/bin/skillwire" status --output json

env HOME="$SW004_PROFILE" \
  XDG_CONFIG_HOME="$SW004_CONFIG" XDG_DATA_HOME="$SW004_DATA" \
  XDG_STATE_HOME="$SW004_STATE" XDG_CACHE_HOME="$SW004_CACHE" \
  XDG_RUNTIME_DIR="$SW004_RUNTIME" \
  "$SW004_PROFILE/.local/bin/skillwire" doctor --output json
```

Expected: exactly one account, one active key/reference per client, one service volume, one MCP entry and plugin per client, no changed bytes/writes for an unchanged setup, and no raw identifier/secret/unrelated profile value in output. `doctor` classifies injected fixtures with stable codes and safe actions.

## 8. Prove fail-open clients and secret containment

Run the focused outage/canary acceptance suite:

```bash
pnpm exec vitest run --project e2e \
  tests/e2e/self-hosted-onboarding/fail-open-clients.test.ts
pnpm exec vitest run --project security \
  tests/security/onboarding/secret-containment.test.ts
```

Expected across stopped/unreachable/401/missing credential/locked store/timeout/incompatible/six-tool-mismatch fixtures:

- ordinary Codex and Claude processes start and complete unrelated work;
- bridge attempts once, exits promptly, and never prompts/retries;
- client logs and config contain only stable error/reference data;
- generated canaries occur zero times in argv, environment, `/proc`, Docker logs, terminal captures, configs, diffs, snapshots, journals, backups, reports, test artifacts, and repository files.

## 9. Validate backup and both upgrade boundaries

```bash
env HOME="$SW004_PROFILE" \
  XDG_CONFIG_HOME="$SW004_CONFIG" XDG_DATA_HOME="$SW004_DATA" \
  XDG_STATE_HOME="$SW004_STATE" XDG_CACHE_HOME="$SW004_CACHE" \
  XDG_RUNTIME_DIR="$SW004_RUNTIME" \
  "$SW004_PROFILE/.local/bin/skillwire" backup

pnpm exec vitest run --project integration \
  tests/integration/onboarding/backup-restore-validation.test.ts \
  tests/integration/onboarding/upgrade-compatible.test.ts \
  tests/integration/onboarding/upgrade-forward-only-010.test.ts
```

Expected: backup success only after isolated restore and application checks; no raw secret in the backup; compatible application/config rollback before a schema boundary; refused pre-010 image-only rollback after 010 with writers stopped, validated backup identified, and exact restore/compatible-release guidance.

## 10. Validate partial failure, interruption, and external ownership

```bash
pnpm exec vitest run --project e2e \
  tests/e2e/self-hosted-onboarding/dual-client-partial-failure.test.ts \
  tests/e2e/self-hosted-onboarding/external-integration-reuse.test.ts

pnpm exec vitest run --project integration \
  tests/integration/onboarding/interruption-recovery.test.ts \
  tests/integration/onboarding/concurrent-mutator.test.ts
```

Expected: a verified client/service survive the other client's failure; only the failed transaction's new config/credential/key is compensated; external equivalent state is never claimed/repaired/removed; every injected kill converges or yields recovery-required without a false success marker; exactly one concurrent mutator proceeds.

For a same-name non-equivalent entry and for an alternate-name/ambiguous equivalent, verify that only the affected client is blocked with a redacted external-resolution result. Setup, repair, upgrade, uninstall, and purge must never adopt, rename, overwrite, disable, or remove it; the healthy service and other successful client remain retained.

## 11. Validate explicit service-secret rotation

Run the rotation fault suite and preview one disposable application-pepper rotation:

```bash
pnpm exec vitest run --project integration \
  tests/integration/onboarding/service-secret-rotation.test.ts

env HOME="$SW004_PROFILE" \
  XDG_CONFIG_HOME="$SW004_CONFIG" XDG_DATA_HOME="$SW004_DATA" \
  XDG_STATE_HOME="$SW004_STATE" XDG_CACHE_HOME="$SW004_CACHE" \
  XDG_RUNTIME_DIR="$SW004_RUNTIME" \
  "$SW004_PROFILE/.local/bin/skillwire" \
  maintenance rotate-service-secret application-pepper --preview-only
```

Expected: only this explicit maintenance route can rotate a service secret; the old value remains until affected consumers pass readiness and the journal commits. Every injected failure restores the old compatible configuration or reports recovery-required. No raw old/new value appears in output, Compose rendering, environment, logs, journal, backup, or test artifacts.

## 12. Validate uninstall, reinstall, and purge

Preview and confirm default `uninstall`.

Expected: owned client MCP/plugin/marketplace state is removed, containers stop, and external/unrelated profile state plus volume, backups, secrets, release, and ownership metadata remain. Repeat setup and confirm the retained service identity/data return with no duplicate account/client entry.

On this disposable fixture only, preview `purge`. Verify the preview names the installation ID and every exact owned retained path/volume/credential, then confirm its exact hash.

Expected: only those owned targets disappear, external/unrelated state remains, and the final result lists what is unrecoverable. A default-uninstall confirmation hash cannot authorize purge.

## 13. Validate full acceptance and release evidence

The release matrix must record all 28 numbered Feature 004 acceptance scenarios, both architectures and supported OS/client combinations, rootless/rootful evidence where supported, every unchanged Feature 001-003 gate, and signing/trust rotation/revocation/downgrade faults. Clean-host setup elapsed time is informational release evidence; the 15-minute/95% success criterion is evaluated through the specified moderated participant study and is not substituted with a CI wall-clock threshold.

## 14. Final repository and profile assertions

```bash
git -C "$SW004_REPOSITORY" status --porcelain=v1 \
  > "$SW004_ROOT/repository-after.txt"
cmp "$SW004_ROOT/repository-before.txt" "$SW004_ROOT/repository-after.txt"
```

The full acceptance harness additionally compares arbitrary seeded unrelated Codex/Claude configuration, authentication sentinels, plugins, skills, hooks, histories, comments where preserved, and MCP servers across setup, repair, upgrade, uninstall, failure, and interruption. Expected: 100% preservation, zero repository writes, and zero catalog skill/resource installation.

After all assertions, remove only the known disposable root and any explicitly named disposable Docker resources created by the test harness. Never use a broad home/workspace path or unresolved variable as a deletion target.
