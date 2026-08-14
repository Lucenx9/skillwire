/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production upgrade interfaces. */
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  previewUpgrade,
  runUpgrade,
} from "../../../src/onboarding/application/upgrade.js";
import type { UpgradeRecoveryError } from "../../../src/onboarding/application/upgrade.js";

describe("same-schema signed upgrade", () => {
  it("automatically rolls application/config back when readiness fails", async () => {
    const target = {
      releaseId: "11-amd64",
      releaseSequence: 11,
      trustPolicySequence: 5,
      schemaMinimum: 10,
      schemaMaximum: 10,
      latestMigration: 10,
      manifestSha256: "a".repeat(64),
      imageDigest: `sha256:${"b".repeat(64)}`,
    };
    const preview = previewUpgrade({
      installationId: randomUUID(),
      currentReleaseSequence: 10,
      currentTrustPolicySequence: 5,
      liveSchema: 10,
      target,
    });
    const rollbackApplication = vi.fn(async () => undefined);
    const migrate = vi.fn(async () => undefined);
    const drain = vi.fn(async () => undefined);
    const events: string[] = [];

    await expect(
      runUpgrade({
        preview,
        confirmation: preview.previewHash,
        signal: new AbortController().signal,
        verifyTarget: async () => {
          events.push("verified");
          return target;
        },
        createBackup: async () => {
          events.push("backup");
          return { backupId: randomUUID(), validated: true };
        },
        drainWriters: drain,
        installApplication: async () => {
          events.push("installed");
        },
        migrate,
        verifyLiveSchema: async () => 10,
        readiness: async () => {
          throw new Error("not ready");
        },
        verifyClients: async () => undefined,
        commitSelection: async () => undefined,
        rollbackApplication,
        stopWriters: async () => undefined,
        restartWriters: async () => undefined,
      }),
    ).rejects.toMatchObject({
      rollbackBoundary: "application-config",
    } satisfies Partial<UpgradeRecoveryError>);
    expect(events).toEqual(["verified", "backup", "installed"]);
    expect(rollbackApplication).toHaveBeenCalledTimes(1);
    expect(migrate).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });
});
