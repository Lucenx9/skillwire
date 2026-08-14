/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production upgrade interfaces. */
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  previewUpgrade,
  runUpgrade,
} from "../../../src/onboarding/application/upgrade.js";

describe("forward-only migration 010 upgrade", () => {
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
        readiness: async () => {
          throw new Error("service failed after migration");
        },
        verifyClients: async () => undefined,
        commitSelection: async () => undefined,
        rollbackApplication,
        stopWriters,
        restartWriters: async () => undefined,
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
