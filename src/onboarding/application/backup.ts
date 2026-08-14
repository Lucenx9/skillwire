import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { atomicWriteJson } from "../adapters/filesystem/atomic-state.js";
import type { PostgresBackupAdapter } from "../adapters/postgres/backup.js";
import {
  BackupRecordSchema,
  type ServiceSecretReferenceSchema,
} from "../domain/installation.js";
import type { z } from "zod";
import { dirname, resolve } from "node:path";
import type { OperationJournal } from "../domain/operation-journal.js";

type ServiceSecretReference = z.infer<typeof ServiceSecretReferenceSchema>;

export async function createValidatedBackup(options: {
  readonly installationId: string;
  readonly sourceReleaseId: string;
  readonly serviceSecretReferences: readonly ServiceSecretReference[];
  readonly clientCredentialReferences: readonly string[];
  readonly adapter: PostgresBackupAdapter;
  readonly signal: AbortSignal;
  readonly journal?: OperationJournal | undefined;
}): Promise<
  z.infer<typeof BackupRecordSchema> & {
    readonly archivePath: string;
    readonly backupRoot: string;
    readonly backupIdentitySha256: string;
  }
> {
  const backup =
    options.journal === undefined
      ? await options.adapter.createAndValidate(options.signal)
      : await options.journal.runEffect({
          step: "backup-create-and-restore-validate",
          intent: { installationId: options.installationId },
          signal: options.signal,
          action: () => options.adapter.createAndValidate(options.signal),
          verification: (value) => ({
            backupId: value.backupId,
            archiveSha256: value.archiveSha256,
            restored: value.validation.ready,
          }),
        });
  const record = BackupRecordSchema.parse({
    schemaVersion: "skillwire.backup/v1",
    backupId: backup.backupId,
    installationId: options.installationId,
    status: "validated",
    createdAt: new Date().toISOString(),
    archiveSha256: backup.archiveSha256,
    sourceReleaseId: options.sourceReleaseId,
    serviceSecretReferences: options.serviceSecretReferences,
    clientCredentialReferences: options.clientCredentialReferences,
  });
  const root = dirname(backup.archivePath);
  const protectedFileSha256 = async (path: string): Promise<string> => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o600
      )
        throw new Error("Backup metadata is not a protected regular file");
      return createHash("sha256")
        .update(await handle.readFile())
        .digest("hex");
    } finally {
      await handle.close();
    }
  };
  const publish = async () => {
    const recoveryManifestPath = resolve(root, "recovery-manifest.json");
    const validationPath = resolve(root, "validation.json");
    await atomicWriteJson(
      recoveryManifestPath,
      {
        ...record,
        archiveLocator: "database.dump",
      },
      root,
    );
    await atomicWriteJson(
      validationPath,
      {
        schemaVersion: "skillwire.backup-validation/v1",
        backupId: backup.backupId,
        status: "validated",
        validation: backup.validation,
      },
      root,
    );
    await atomicWriteJson(
      resolve(root, "checksums.json"),
      {
        schemaVersion: "skillwire.backup-checksums/v1",
        backupId: backup.backupId,
        files: {
          "database.dump": backup.archiveSha256,
          "recovery-manifest.json":
            await protectedFileSha256(recoveryManifestPath),
          "validation.json": await protectedFileSha256(validationPath),
        },
      },
      root,
    );
  };
  if (options.journal === undefined) await publish();
  else
    await options.journal.runEffect({
      step: "backup-state-publication",
      intent: { backupId: backup.backupId },
      signal: options.signal,
      action: publish,
      verification: () => ({ backupId: backup.backupId, published: true }),
    });
  return {
    ...record,
    archivePath: backup.archivePath,
    backupRoot: root,
    backupIdentitySha256: await backupDirectoryIdentity(root),
  };
}

export async function backupDirectoryIdentity(root: string): Promise<string> {
  const expected = [
    "checksums.json",
    "database.dump",
    "recovery-manifest.json",
    "validation.json",
  ];
  const names = (await readdir(root)).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error("Backup file set is incomplete or contains unknown files");
  const digest = createHash("sha256").update(
    "skillwire-backup-directory-identity-v1\0",
  );
  for (const name of names) {
    digest.update(name).update("\0");
    const handle = await open(
      resolve(root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o600
      )
        throw new Error("Backup file set contains an unsafe object");
      digest.update(await handle.readFile()).update("\0");
    } finally {
      await handle.close();
    }
  }
  return digest.digest("hex");
}
