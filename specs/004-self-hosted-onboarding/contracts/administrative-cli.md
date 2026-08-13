# Contract: `skillwire` Administrative CLI

## Scope

This contract defines the supported human and machine interface for one local installation. It does not expose a network administration API and does not change the six MCP operations.

## Invocation grammar

```text
skillwire setup [--clients none|codex|claude|codex,claude]
                [--source mattpocock/skills] [--source obra/superpowers]
skillwire status
skillwire doctor
skillwire clients list
skillwire clients install codex|claude
skillwire clients verify codex|claude
skillwire clients uninstall codex|claude
skillwire clients rotate-key codex|claude
skillwire repair [--component <owned-component-id>]
skillwire backup
skillwire upgrade --release <verified-release-archive>
skillwire maintenance rotate-service-secret database-password|application-pepper
skillwire uninstall
skillwire purge

Global output/confirmation options:
  --output human|json              default: human
  --preview-only                   never mutate
  --confirm-preview <sha256>       non-interactive approval of this exact preview
  --state-root <absolute-path>     test/diagnostic override only; rejected in normal setup
```

Unknown commands/options, repeated scalar flags, unsupported client/source values, relative release paths, or simultaneous contradictory options are invalid invocation. `status`, `doctor`, `clients list`, and `clients verify` are read-only and never prompt. Every other command is mutating, including key rotation and source registration.

## Executable dispatcher

The package executable and distributed `bin/skillwire` launcher resolve to `src/onboarding/cli/main.ts`. That file is the sole process dispatcher: it parses argv once, routes the exact internal `bridge` command directly to MCP STDIO mode, and routes every administrative command above to the administrative command router. No wrapper executable, alternate normal-user profile, or second command-specific entry point is supported.

Bridge mode bypasses administrative preview, progress, and rendering; stdout is exclusively MCP protocol bytes and bounded pre-initialization diagnostics use stderr. Administrative `--output json` emits exactly one JSON document on stdout, while human progress and diagnostics use stderr. The dispatcher maps domain outcomes to the exit table once, rejects extra argv before side effects, and installs shared bounded `SIGINT`/`SIGTERM` cancellation. A journaled mutation may stop only at its documented safe boundary and never prints a secret while cancelling.

## Preview and confirmation

Before its first mutation a command MUST:

1. Resolve and validate the active installation, release, XDG roots, Docker context, client scopes/policies, current ownership, and exact target state.
2. Produce a canonical redacted preview containing all intended additions, replacements, removals, retained assets, external dependencies, ports, containers, volumes, release/image identities, credential backend/locations, client scopes, backup/rollback boundary, and expected validation.
3. Compute `previewHash = SHA-256(canonical JSON preview)`.
4. Stop if `--preview-only` is present.
5. Otherwise obtain either an interactive confirmation that repeats the command's displayed scope or an exact `--confirm-preview <previewHash>` value.
6. Revalidate all preconditions and identities immediately before mutation. Any drift invalidates the preview and requires a new one.

`--confirm-preview` is rejected if the hash, command, normalized arguments, release, ownership revision, client profile identities, or live prerequisites changed. A bare `--yes` flag is not supported.

`purge` is distinct from default `uninstall`. Its preview lists each exact SkillWire-owned data, backup, credential, release, state path, Compose project, and volume that will become unrecoverable. Interactive confirmation must include the `installationId`; non-interactive confirmation still requires the exact purge preview hash.

## Command behavior

### `setup`

- Defaults to an interactive client selection; non-interactive use must supply `--clients` explicitly.
- Validates the release before installing files or pulling images.
- Installs/reuses one service and one account, then performs one independent transaction per selected client.
- `none` installs an administrable service and makes no client-profile change.
- Source flags are explicit opt-ins and run only through the existing source pipeline after first-party readiness.
- A failed client transaction is compensated without undoing the healthy service or another verified client. The result is `incomplete`, never success.
- A repeated unchanged setup performs no write, secret/key rotation, account creation, source registration, or client-manager mutation.

### `status`

Reads installed state and bounded live health without repair. It reports installation/release/schema/catalog, retained data, selected-client summary, and active operation/recovery state. It never retrieves a raw credential or starts a client.

### `doctor`

Performs safe layered diagnostics and emits stable findings for release/filesystem, Docker, PostgreSQL, migrations, catalog/advisories, credentials, bridge, client version/profile/plugin/MCP, exact six-tool contract, activation-adapter availability, source sync, backup, and journal recovery. A finding contains only redacted owned paths and categorical/version/hash evidence.

### `clients install|verify|uninstall|rotate-key`

- All mutation is explicitly scoped to one client.
- `install` creates/reuses only that client's key/credential/MCP/plugin state.
- `verify` starts a fresh normal user client and runs deterministic verification; it is read-only with respect to configuration, keys, and service data apart from existing authenticated usage semantics of an exact load.
- `uninstall` removes only currently matching owned entries, adapter, credential, and key. External reused state remains.
- `rotate-key` creates and persists a replacement before switching verification, then revokes the old key only after success. Failure retains the old working key and removes the replacement.

### `repair`

Defaults to a full redacted preview. It can mutate only drifted state with an unambiguous current ownership proof. It never deletes persistent data, rotates a secret, rewrites external dependencies, normalizes unrelated profile content, or crosses a schema incompatibility.

If the exact logical name `skillwire` or any required adapter name already exists but is non-equivalent or ambiguous, only that client's mutation is blocked. The result identifies the client, conflicting logical component, observed non-secret scope/identity, and required external resolution. Setup, repair, upgrade, uninstall, and purge never adopt, rename, overwrite, disable, or remove that state. A healthy service and another successful client remain retained.

### `backup`

Creates a protected custom-format PostgreSQL dump and minimum non-secret recovery metadata. It returns success only after checksum and isolated restore/application validation. Invalid candidates are retained only when useful for diagnosis and clearly marked invalid.

### `upgrade`

Validates the target release and compatibility, creates/validates a backup, identifies forward-only migrations, previews downtime/rollback, drains writers when required, migrates with the existing gate, starts the exact target images, and re-verifies service plus selected clients. It automatically restores application/config state only while schema-compatible. After migration 010, an unsafe pre-010 image rollback returns `rollback-required` and keeps writers stopped.

### `maintenance rotate-service-secret`

Rotates exactly one database/application secret through the dedicated service-secret contract. It retains the prior secret until all affected consumers pass readiness and a durable commit is written. Failure restores compatible configuration to the old value or returns `recovery-required`; it never rotates a client key or regenerates the other service secret.

### `uninstall`

Removes only matching owned client entries/plugins/marketplaces, stops/removes owned containers, and retains the database volume, backups, secrets/credentials, releases needed for recovery, and ownership metadata. Reinstall reuses the retained installation identity and data without duplicates.

### `purge`

Runs only after default-uninstall-equivalent client/service removal is safe. It deletes only the separately named and confirmed owned retained assets. Ambiguous/drifted/external state blocks that asset's deletion and produces a non-success result. The final output says exactly which material is no longer recoverable.

## Machine-readable envelope

Every command supports one JSON document on stdout. Diagnostics and progress go to stderr only in human mode; JSON mode emits no non-JSON stdout.

```json
{
  "schemaVersion": "skillwire.admin-result/v1",
  "command": "setup",
  "operationId": "5d681bef-5f4a-47ce-8249-8da498b058fa",
  "status": "preview|success|incomplete|failure|cancelled|recovery-required",
  "exitClass": "success",
  "previewHash": "64-lowercase-hex-or-null",
  "changed": false,
  "summary": "Bounded redacted summary",
  "components": [
    {
      "component": "service|service-secret|codex|claude|backup|source",
      "state": "stable-code",
      "changed": false,
      "owned": true,
      "identity": { "version": "non-secret-version-or-hash" }
    }
  ],
  "findings": [
    {
      "code": "STABLE_CODE",
      "severity": "info|warning|error|recovery-required",
      "component": "credential",
      "summary": "Redacted evidence",
      "nextAction": "Safe next action"
    }
  ],
  "recovery": {
    "rollbackBoundary": "automatic|client-only|application-config|database-restore-required|none",
    "backupId": "uuid-or-null",
    "instructions": ["Bounded redacted step"]
  }
}
```

Unknown additional fields are permitted only in a new schema version. Arrays have implementation-defined documented bounds and deterministic ordering. Raw secrets, account IDs, repository hashes, prompts/responses, Git metadata, client login state, and unrelated profile values are forbidden everywhere in the envelope.

## Exit classes

| Process code | `exitClass` | Meaning |
|-------------:|-------------|---------|
| 0 | `success` | Requested state observed and all applicable deterministic gates passed. |
| 2 | `invalid-invocation` | Invalid syntax or incompatible options. |
| 3 | `unsupported-prerequisite` | Unsupported OS/arch/version, missing Docker capability, remote context, or unavailable required executable. |
| 4 | `policy-or-ownership-conflict` | Managed policy, conflicting/ambiguous external state, unsafe path, stale preview, concurrent mutation, or missing ownership proof. |
| 5 | `degraded-or-incomplete` | Healthy retained state but a selected optional/source/client result is degraded or independently failed. |
| 6 | `service-failure` | Container, PostgreSQL, readiness, catalog, advisory, or bounded network operation failed. |
| 7 | `credential-or-authentication-failure` | Secure persistence/resolution failed or authentication was rejected. |
| 8 | `client-contract-failure` | Client/plugin/MCP registration, exact six-tool discovery, or scripted journey failed. |
| 9 | `schema-incompatibility` | Newer/drifted/unsupported schema or refused application/schema pairing. |
| 10 | `rollback-required` | Automatic rollback is unsafe; writers remain stopped and validated restore/compatible release is required. |
| 11 | `user-cancellation` | No mutation started, or a confirmed operation stopped at a documented safe cancellation boundary. |
| 12 | `release-integrity-failure` | Manifest signature, artifact/image/plugin/catalog/advisory/migration identity failed. |
| 1 | `internal-failure` | Unexpected bounded failure; no success marker and a recovery-safe journal remains. |

Exit classes are stable within `skillwire.admin-result/v1`. A JSON result's `exitClass` and the process exit code must agree.

## Output and redaction invariants

- Human and JSON output end with state, affected components, per-client results, backup/rollback location when applicable, and a safe next action.
- Owned paths may be displayed because the user must review them; unrelated profile paths/values and all raw secrets may not.
- Subprocess argv/environment, process listings, Docker logs, terminal capture, previews, diffs, journals, backups, reports, and crash messages contain no raw API key, GitHub token, database password, or application secret.
- No command changes the current repository or creates `.codex`, `.claude`, `.mcp.json`, skill, or generated task files there.
