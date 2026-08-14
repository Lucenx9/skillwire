import { canonicalPreview, confirmPreview } from "../cli/confirmation.js";
import { classifySchemaUpgrade } from "../adapters/postgres/schema-compatibility.js";
import { UpgradeRecoveryError } from "./upgrade-recovery.js";
import type { OperationJournal } from "../domain/operation-journal.js";

export { UpgradeRecoveryError } from "./upgrade-recovery.js";

export function upgradeFailureRequiresRecovery(
  restoreRequired: boolean,
  hasUnprovenEffect: boolean,
): boolean {
  return restoreRequired || hasUnprovenEffect;
}

export interface UpgradeTarget {
  readonly releaseId: string;
  readonly releaseSequence: number;
  readonly trustPolicySequence: number;
  readonly schemaMinimum: number;
  readonly schemaMaximum: number;
  readonly latestMigration: number;
  readonly manifestSha256: string;
  readonly imageDigest: string;
}

export interface UpgradePreview {
  readonly installationId: string;
  readonly currentReleaseSequence: number;
  readonly currentTrustPolicySequence: number;
  readonly liveSchema: number;
  readonly target: UpgradeTarget;
  readonly previewHash: string;
}

export function previewUpgrade(
  input: Omit<UpgradePreview, "previewHash">,
): UpgradePreview {
  return {
    ...input,
    previewHash: canonicalPreview("upgrade", input).hash,
  };
}

function sameTarget(left: UpgradeTarget, right: UpgradeTarget): boolean {
  return (
    left.releaseId === right.releaseId &&
    left.releaseSequence === right.releaseSequence &&
    left.trustPolicySequence === right.trustPolicySequence &&
    left.schemaMinimum === right.schemaMinimum &&
    left.schemaMaximum === right.schemaMaximum &&
    left.latestMigration === right.latestMigration &&
    left.manifestSha256 === right.manifestSha256 &&
    left.imageDigest === right.imageDigest
  );
}

function ensureNotAborted(signal: AbortSignal, boundary: string): void {
  if (signal.aborted)
    throw new Error(`Upgrade cancelled at the ${boundary} boundary`);
}

export async function runUpgrade(options: {
  readonly preview: UpgradePreview;
  readonly confirmation: string | undefined;
  readonly signal: AbortSignal;
  readonly verifyTarget: () => Promise<UpgradeTarget>;
  readonly createBackup: () => Promise<{
    readonly backupId: string;
    readonly validated: boolean;
  }>;
  readonly drainWriters: () => Promise<void>;
  readonly installApplication: () => Promise<void>;
  readonly migrate: () => Promise<void>;
  readonly verifyLiveSchema: () => Promise<number>;
  readonly preActivationReadiness: () => Promise<void>;
  readonly verifyClients: () => Promise<void>;
  readonly activateApplication: () => Promise<void>;
  readonly commitSelection: () => Promise<void>;
  readonly rollbackApplication: () => Promise<void>;
  readonly stopWriters: () => Promise<void>;
  readonly journal?: OperationJournal | undefined;
}): Promise<{ readonly backupId: string; readonly releaseId: string }> {
  confirmPreview(
    { command: "upgrade", json: "", hash: options.preview.previewHash },
    options.confirmation,
  );
  if (options.signal.aborted) throw new Error("Upgrade cancelled");
  const effect = async <T>(
    step: string,
    action: () => Promise<T>,
    verification: (
      value: T,
    ) => Record<string, string | number | boolean | null>,
  ): Promise<T> =>
    options.journal === undefined
      ? action()
      : options.journal.runEffect({
          step,
          intent: { command: "upgrade" },
          signal: options.signal,
          action,
          verification,
        });
  const target = await effect(
    "upgrade-release-verification",
    options.verifyTarget,
    (value) => ({
      releaseSequence: value.releaseSequence,
      trustPolicySequence: value.trustPolicySequence,
    }),
  );
  ensureNotAborted(options.signal, "release-verification");
  if (!sameTarget(target, options.preview.target))
    throw new Error("Verified upgrade target changed after preview");
  if (target.releaseSequence <= options.preview.currentReleaseSequence)
    throw new Error(
      "Release downgrade or equal-sequence replacement is forbidden",
    );
  if (target.trustPolicySequence < options.preview.currentTrustPolicySequence)
    throw new Error("Trust policy downgrade is forbidden");
  if (!/^sha256:[0-9a-f]{64}$/.test(target.imageDigest))
    throw new Error("Upgrade image is not digest-pinned");
  const decision = classifySchemaUpgrade({
    liveSchema: options.preview.liveSchema,
    schemaMinimum: target.schemaMinimum,
    schemaMaximum: target.schemaMaximum,
    latestMigration: target.latestMigration,
    forwardOnlyMigrations: [10],
  });
  const backup = await effect(
    "upgrade-backup",
    options.createBackup,
    (value) => ({
      backupId: value.backupId,
      validated: value.validated,
    }),
  );
  if (!backup.validated)
    throw new Error("Upgrade backup is not restore-validated");
  ensureNotAborted(options.signal, "backup");
  let applicationInstalled = false;
  let writersDrained = false;
  let releaseCommitted = false;
  const migration = { started: false };
  try {
    if (decision.requiresWriterDrain) {
      await effect("upgrade-writer-drain", options.drainWriters, () => ({
        drained: true,
      }));
      writersDrained = true;
      ensureNotAborted(options.signal, "writer-drain");
    }
    await effect(
      "upgrade-application-install",
      options.installApplication,
      () => ({ installed: true }),
    );
    applicationInstalled = true;
    ensureNotAborted(options.signal, "application-install");
    if (decision.kind === "forward-only") {
      await effect(
        "upgrade-migration",
        async () => {
          migration.started = true;
          await options.migrate();
        },
        () => ({ schema: target.latestMigration }),
      );
      ensureNotAborted(options.signal, "migration");
    }
    const liveSchema = await effect(
      "upgrade-schema-readback",
      options.verifyLiveSchema,
      (value) => ({ schema: value }),
    );
    if (liveSchema !== target.latestMigration)
      throw new Error("Live schema readback did not match the target");
    await effect(
      "upgrade-preactivation-readiness",
      options.preActivationReadiness,
      () => ({
        ready: true,
      }),
    );
    ensureNotAborted(options.signal, "readiness");
    await effect("upgrade-client-verification", options.verifyClients, () => ({
      clientsVerified: true,
    }));
    ensureNotAborted(options.signal, "client-verification");
    await effect("upgrade-release-commit", options.commitSelection, () => ({
      releaseSequence: target.releaseSequence,
    }));
    releaseCommitted = true;
    ensureNotAborted(options.signal, "release-commit");
    await effect(
      "upgrade-application-activation",
      options.activateApplication,
      () => ({ activated: true }),
    );
    writersDrained = false;
    ensureNotAborted(options.signal, "application-activation");
    return { backupId: backup.backupId, releaseId: target.releaseId };
  } catch (error) {
    if (releaseCommitted) {
      await options.stopWriters().catch(() => undefined);
      throw new UpgradeRecoveryError(
        "Upgrade committed the target release but public activation did not complete",
        "application-config",
        backup.backupId,
        "Retry target activation; do not restore the pre-upgrade backup",
        { cause: error },
      );
    }
    if (decision.kind === "forward-only" && migration.started) {
      await options.stopWriters().catch(() => undefined);
      throw new UpgradeRecoveryError(
        "Forward-only upgrade stopped after migration may have begun",
        "database-restore-required",
        backup.backupId,
        "Restore replaces all database changes after the named backup, including erased-memory records",
        { cause: error },
      );
    }
    if (applicationInstalled || writersDrained)
      await options.rollbackApplication();
    const last = options.journal?.entries.at(-1);
    if (
      last?.phase === "compensate" &&
      last.detail["completion"] === "unproven"
    )
      await options.journal?.compensate(last.step, {
        completion: "recovered",
        recoveryRequired: false,
      });
    throw new UpgradeRecoveryError(
      "Upgrade failed before a forward-only database boundary and application rollback completed",
      "application-config",
      backup.backupId,
      "No database restore is required",
      { cause: error },
    );
  }
}
