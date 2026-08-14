/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production upgrade interfaces. */
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  previewUpgrade,
  runUpgrade,
  type UpgradeTarget,
} from "../../../src/onboarding/application/upgrade.js";

function target(overrides: Partial<UpgradeTarget> = {}): UpgradeTarget {
  return {
    releaseId: "12-amd64",
    releaseSequence: 12,
    trustPolicySequence: 6,
    schemaMinimum: 10,
    schemaMaximum: 10,
    latestMigration: 10,
    manifestSha256: "5".repeat(64),
    imageDigest: `sha256:${"6".repeat(64)}`,
    ...overrides,
  };
}

describe("upgrade trust and downgrade boundary", () => {
  it.each([
    ["lower release", target({ releaseSequence: 9 })],
    ["lower policy", target({ trustPolicySequence: 4 })],
    ["unpinned image", target({ imageDigest: "postgres:17" })],
  ])("rejects %s before backup or mutation", async (_name, candidate) => {
    const preview = previewUpgrade({
      installationId: randomUUID(),
      currentReleaseSequence: 10,
      currentTrustPolicySequence: 5,
      liveSchema: 10,
      target: candidate,
    });
    const createBackup = vi.fn();
    await expect(
      runUpgrade({
        preview,
        confirmation: preview.previewHash,
        signal: new AbortController().signal,
        verifyTarget: async () => candidate,
        createBackup,
        drainWriters: vi.fn(),
        installApplication: vi.fn(),
        migrate: vi.fn(),
        verifyLiveSchema: vi.fn(),
        readiness: vi.fn(),
        verifyClients: vi.fn(),
        commitSelection: vi.fn(),
        rollbackApplication: vi.fn(),
        stopWriters: vi.fn(),
        restartWriters: vi.fn(),
      }),
    ).rejects.toThrow(/downgrade|digest|pinned|sequence/i);
    expect(createBackup).not.toHaveBeenCalled();
  });

  it.each(["stale policy", "bad overlap", "denied signer/material"])(
    "propagates signed-release verifier rejection for %s without effects",
    async (reason) => {
      const candidate = target();
      const preview = previewUpgrade({
        installationId: randomUUID(),
        currentReleaseSequence: 10,
        currentTrustPolicySequence: 5,
        liveSchema: 10,
        target: candidate,
      });
      const createBackup = vi.fn();
      await expect(
        runUpgrade({
          preview,
          confirmation: preview.previewHash,
          signal: new AbortController().signal,
          verifyTarget: async () => {
            throw new Error(reason);
          },
          createBackup,
          drainWriters: vi.fn(),
          installApplication: vi.fn(),
          migrate: vi.fn(),
          verifyLiveSchema: vi.fn(),
          readiness: vi.fn(),
          verifyClients: vi.fn(),
          commitSelection: vi.fn(),
          rollbackApplication: vi.fn(),
          stopWriters: vi.fn(),
          restartWriters: vi.fn(),
        }),
      ).rejects.toThrow(reason);
      expect(createBackup).not.toHaveBeenCalled();
    },
  );
});
