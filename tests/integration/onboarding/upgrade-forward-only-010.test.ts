/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production upgrade interfaces. */
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  previewUpgrade,
  runUpgrade,
} from "../../../src/onboarding/application/upgrade.js";
import type { UpgradeRecoveryError } from "../../../src/onboarding/application/upgrade.js";

describe("forward-only migration 010 upgrade", () => {
  it("treats migration 011 reconciliation as a forward-only boundary", async () => {
    const target = {
      releaseId: "11-amd64",
      releaseSequence: 11,
      trustPolicySequence: 4,
      schemaMinimum: 9,
      schemaMaximum: 11,
      latestMigration: 11,
      manifestSha256: "1".repeat(64),
      imageDigest: `sha256:${"2".repeat(64)}`,
    };
    const preview = previewUpgrade({
      installationId: randomUUID(),
      currentReleaseSequence: 10,
      currentTrustPolicySequence: 4,
      liveSchema: 10,
      target,
    });
    const drainWriters = vi.fn(async () => undefined);
    const migrate = vi.fn(async () => undefined);

    await expect(
      runUpgrade({
        preview,
        confirmation: preview.previewHash,
        signal: new AbortController().signal,
        verifyTarget: async () => target,
        createBackup: async () => ({
          backupId: randomUUID(),
          validated: true,
        }),
        drainWriters,
        installApplication: async () => undefined,
        migrate,
        verifyLiveSchema: async () => 11,
        preActivationReadiness: async () => undefined,
        verifyClients: async () => undefined,
        activateApplication: async () => undefined,
        commitSelection: async () => undefined,
        rollbackApplication: async () => undefined,
        stopWriters: async () => undefined,
      }),
    ).resolves.toMatchObject({ releaseId: target.releaseId });
    expect(drainWriters).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it("keeps the public writer stopped through preactivation and client gates", async () => {
    const target = {
      releaseId: "10-amd64",
      releaseSequence: 10,
      trustPolicySequence: 4,
      schemaMinimum: 9,
      schemaMaximum: 10,
      latestMigration: 10,
      manifestSha256: "1".repeat(64),
      imageDigest: `sha256:${"2".repeat(64)}`,
    };
    const preview = previewUpgrade({
      installationId: randomUUID(),
      currentReleaseSequence: 9,
      currentTrustPolicySequence: 4,
      liveSchema: 9,
      target,
    });
    const events: string[] = [];
    let publicWriterRunning = true;

    await expect(
      runUpgrade({
        preview,
        confirmation: preview.previewHash,
        signal: new AbortController().signal,
        verifyTarget: async () => target,
        createBackup: async () => ({
          backupId: randomUUID(),
          validated: true,
        }),
        drainWriters: async () => {
          publicWriterRunning = false;
          events.push("writers-drained");
        },
        installApplication: async () => {
          events.push("application-staged");
        },
        migrate: async () => {
          events.push("migration-010");
        },
        verifyLiveSchema: async () => 10,
        preActivationReadiness: async () => {
          expect(publicWriterRunning).toBe(false);
          events.push("preactivation-ready");
        },
        verifyClients: async () => {
          expect(publicWriterRunning).toBe(false);
          events.push("clients-verified");
        },
        activateApplication: async () => {
          publicWriterRunning = true;
          events.push("target-activated");
        },
        commitSelection: async () => {
          events.push("release-committed");
        },
        rollbackApplication: vi.fn(),
        stopWriters: vi.fn(),
      }),
    ).resolves.toMatchObject({ releaseId: target.releaseId });
    expect(events).toEqual([
      "writers-drained",
      "application-staged",
      "migration-010",
      "preactivation-ready",
      "clients-verified",
      "release-committed",
      "target-activated",
    ]);
  });

  it("keeps writers stopped and recovery actionable when activation fails after release commit", async () => {
    const target = {
      releaseId: "10-amd64",
      releaseSequence: 10,
      trustPolicySequence: 4,
      schemaMinimum: 9,
      schemaMaximum: 10,
      latestMigration: 10,
      manifestSha256: "1".repeat(64),
      imageDigest: `sha256:${"2".repeat(64)}`,
    };
    const preview = previewUpgrade({
      installationId: randomUUID(),
      currentReleaseSequence: 9,
      currentTrustPolicySequence: 4,
      liveSchema: 9,
      target,
    });
    const stopWriters = vi.fn(async () => undefined);
    const rollbackApplication = vi.fn(async () => undefined);
    const commitSelection = vi.fn(async () => undefined);

    await expect(
      runUpgrade({
        preview,
        confirmation: preview.previewHash,
        signal: new AbortController().signal,
        verifyTarget: async () => target,
        createBackup: async () => ({
          backupId: randomUUID(),
          validated: true,
        }),
        drainWriters: async () => undefined,
        installApplication: async () => undefined,
        migrate: async () => undefined,
        verifyLiveSchema: async () => 10,
        preActivationReadiness: async () => undefined,
        verifyClients: async () => undefined,
        commitSelection,
        activateApplication: async () => {
          throw new Error("public socket unavailable");
        },
        rollbackApplication,
        stopWriters,
      }),
    ).rejects.toMatchObject({
      rollbackBoundary: "application-config",
      dataLossBoundary:
        "Retry target activation; do not restore the pre-upgrade backup",
    } satisfies Partial<UpgradeRecoveryError>);
    expect(commitSelection).toHaveBeenCalledTimes(1);
    expect(stopWriters).toHaveBeenCalledTimes(1);
    expect(rollbackApplication).not.toHaveBeenCalled();
  });

  it("restore-validates first, drains writers, reads schema 010, and refuses image-only rollback", async () => {
    const target = {
      releaseId: "10-amd64",
      releaseSequence: 10,
      trustPolicySequence: 4,
      schemaMinimum: 9,
      schemaMaximum: 10,
      latestMigration: 10,
      manifestSha256: "1".repeat(64),
      imageDigest: `sha256:${"2".repeat(64)}`,
    };
    const preview = previewUpgrade({
      installationId: randomUUID(),
      currentReleaseSequence: 9,
      currentTrustPolicySequence: 4,
      liveSchema: 9,
      target,
    });
    const backupId = randomUUID();
    const events: string[] = [];
    const rollbackApplication = vi.fn(async () => undefined);
    const stopWriters = vi.fn(async () => {
      events.push("writers-stopped");
    });

    await expect(
      runUpgrade({
        preview,
        confirmation: preview.previewHash,
        signal: new AbortController().signal,
        verifyTarget: async () => target,
        createBackup: async () => {
          events.push("backup-validated");
          return { backupId, validated: true };
        },
        drainWriters: async () => {
          events.push("writers-drained");
        },
        installApplication: async () => {
          events.push("application-installed");
        },
        migrate: async () => {
          events.push("migration-010");
        },
        verifyLiveSchema: async () => {
          events.push("schema-readback-010");
          return 10;
        },
        preActivationReadiness: async () => {
          throw new Error("service failed after migration");
        },
        verifyClients: async () => undefined,
        activateApplication: async () => undefined,
        commitSelection: async () => undefined,
        rollbackApplication,
        stopWriters,
      }),
    ).rejects.toMatchObject({
      rollbackBoundary: "database-restore-required",
      backupId,
    });
    expect(events).toEqual([
      "backup-validated",
      "writers-drained",
      "application-installed",
      "migration-010",
      "schema-readback-010",
      "writers-stopped",
    ]);
    expect(stopWriters).toHaveBeenCalledTimes(1);
    expect(rollbackApplication).not.toHaveBeenCalled();
  });
});
