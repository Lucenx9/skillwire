import {
  captureProfileSnapshot,
  profileMatchesSnapshotBefore,
  recordExpectedProfilePostImage,
  restoreProfileSnapshot,
  type CaptureProfileSnapshotOptions,
  type ProtectedProfileSnapshot,
} from "../domain/profile-snapshot.js";

export class ProfileTransactionRecoveryError extends Error {
  public constructor(
    message: string,
    readonly snapshot: ProtectedProfileSnapshot,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProfileTransactionRecoveryError";
  }
}

export interface ProfileTransactionOptions<T> {
  readonly snapshot: CaptureProfileSnapshotOptions;
  mutate(): Promise<T>;
  verify(value: T): Promise<void>;
  inverse(): Promise<void>;
}

export async function runProfileTransaction<T>(
  options: ProfileTransactionOptions<T>,
): Promise<{ readonly value: T; readonly snapshot: ProtectedProfileSnapshot }> {
  let snapshot = await captureProfileSnapshot(options.snapshot);
  try {
    const value = await options.mutate();
    snapshot = await recordExpectedProfilePostImage(snapshot);
    await options.verify(value);
    return { value, snapshot };
  } catch (error) {
    if (
      snapshot.entries.some(
        ({ expectedPostIdentity }) => expectedPostIdentity === undefined,
      )
    ) {
      snapshot = await recordExpectedProfilePostImage(snapshot);
    }
    const inverseSucceeded = await (async () => {
      try {
        await options.inverse();
        return await profileMatchesSnapshotBefore(snapshot);
      } catch {
        return false;
      }
    })();
    if (inverseSucceeded) throw error;
    const restored = await restoreProfileSnapshot(snapshot);
    if (restored.restorationState === "restored") throw error;
    throw new ProfileTransactionRecoveryError(
      "Client profile changed concurrently; safe rollback was refused",
      restored,
      { cause: error },
    );
  }
}
