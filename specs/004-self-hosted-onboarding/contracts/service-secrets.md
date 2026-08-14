# Contract: Database and Application Service Secrets

## Scope

`src/onboarding/secrets/service-secrets.ts` is the only component that creates, validates, resolves, or rotates the PostgreSQL password and application API-key pepper used by the self-hosted deployment. These service secrets are distinct from client bearer keys and GitHub source credentials. The component exposes values only to the narrow Compose-launch boundary through private in-process buffers and restrictive mounted files.

## Location and creation

For installation `<installation-id>`, the exact owned root is:

```text
$XDG_DATA_HOME/skillwire/installations/<installation-id>/secrets/
├── database-password
└── application-pepper
```

The normal XDG default applies when `XDG_DATA_HOME` is unset. Creation MUST:

1. Resolve an absolute normalized data root and reject traversal, symlinks, special files, unowned ancestors, or an installation ID that does not match owned state.
2. Create every owned directory with mode `0700` and validate invoking-UID ownership.
3. Generate each value independently from the Node cryptographic random source with at least 256 bits of entropy and an encoding that does not reduce that entropy.
4. Open each final path exclusively without following links, as a regular invoking-UID-owned mode-`0600` file with link count one.
5. Write exactly one bounded value with no extra line, sync the file, close it, sync the directory, then commit only non-secret ownership/reference metadata.

Failure creating either secret commits neither service-ready state nor a success marker. Any staged file is removed only when its exact identity proves it was created by the current operation.

## Validation and idempotence

Setup, repeated setup, repair, upgrade, reinstall after default uninstall, status, and doctor validate the exact owned locator, type, UID, mode, link count, bounded size, and expected format without emitting the value. A valid existing secret is reused byte-for-byte. An absent, changed, unsafe, ambiguous, or unowned secret is a blocking finding; setup and repair do not regenerate it, repair permissions, adopt it, or rotate it.

Compose receives only the exact files required by each service. Secret values are forbidden in Compose YAML, rendered Compose output, environment variables, argv, Docker labels/logs, previews, journals, ownership records, diagnostics, backups, reports, and release artifacts.

## Explicit rotation

Rotation is available only through:

```text
skillwire maintenance rotate-service-secret database-password|application-pepper
```

The mutating command follows the normal preview/hash confirmation and journal protocol. It names the affected service, downtime/readiness work, retained old-secret locator, and rollback boundary without showing either value.

The operation creates a new independently generated candidate file, retains the old exact file, updates only the compatible application/database configuration, and proves migration/schema compatibility plus service readiness before committing. Only after readiness and a durable commit may the old file be removed. On failure, configuration is restored to the retained old value and the candidate is removed only with exact ownership proof. Rotation never changes client keys or the other service secret.

Database-password rotation must update PostgreSQL and application consumers as one journaled boundary. Application-pepper rotation must use the existing authentication compatibility/revocation policy; it must not silently invalidate stored API keys. If the current application cannot support a safe overlap or rollback, preflight blocks the operation.

## Backup, uninstall, and recovery

Backup manifests store only the secret-set ID, exact owned locators, non-secret file identities, and availability state. Raw service-secret bytes are never copied into a backup. Default uninstall retains both secret files. Purge removes them only after the exact installation/asset confirmation and current ownership/identity match. Restore reports missing retained secrets as an explicit rotation or recovery prerequisite; it never reconstructs a value from metadata.

## Required evidence

- Unit tests prove independent entropy generation, exclusive creation, modes, no-follow/link checks, sync ordering, bounded parsing, byte-for-byte reuse, and zero automatic repair/rotation.
- Integration tests mount the restrictive files into the production Compose fixture and prove PostgreSQL plus application readiness without placing values in container environment, config output, or logs.
- Rotation fault tests terminate after every intent/effect/verification/commit boundary and prove either old-service recovery or a precise recovery-required state.
- Security tests scan argv, environment, `/proc`, Compose output, Docker metadata/logs, previews, journals, backups, diagnostics, crash output, and repository diffs for generated canaries.
