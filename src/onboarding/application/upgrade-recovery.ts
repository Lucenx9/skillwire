export class UpgradeRecoveryError extends Error {
  public constructor(
    message: string,
    readonly rollbackBoundary:
      "application-config" | "database-restore-required",
    readonly backupId: string | null,
    readonly dataLossBoundary: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpgradeRecoveryError";
  }
}

export function upgradeRecoveryGuidance(error: UpgradeRecoveryError): {
  readonly rollbackBoundary: UpgradeRecoveryError["rollbackBoundary"];
  readonly backupId: string | null;
  readonly instructions: readonly string[];
} {
  return {
    rollbackBoundary: error.rollbackBoundary,
    backupId: error.backupId,
    instructions:
      error.rollbackBoundary === "database-restore-required"
        ? [
            "Keep all writers stopped",
            "Restore the named validated backup before selecting an older executable",
            "Confirm the erased-memory and data-loss boundary before restore",
          ]
        : [
            "The prior application and configuration were restored automatically",
          ],
  };
}
