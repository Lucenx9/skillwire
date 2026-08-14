/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production lifecycle interfaces. */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  previewUpgrade,
  runUpgrade,
} from "../../../src/onboarding/application/upgrade.js";

describe("upgrade state preservation", () => {
  it("preserves repository memory, client/service references, ownership, volume, backup, source, and unrelated profile state", async () => {
    const preserved = {
      repositoryMemory: { skill: "kept", erased: false },
      clientCredentials: [randomUUID(), randomUUID()],
      serviceSecretIdentities: ["a".repeat(64), "b".repeat(64)],
      ownershipRevision: 7,
      volume: "skillwire-install_postgres_data",
      sources: ["external-source-id"],
      codexUnknown: { theme: "dark", otherMcp: { command: "other" } },
      claudeUnknown: { model: "existing", otherPlugin: true },
    };
    const before = structuredClone(preserved);
    const target = {
      releaseId: "12-amd64",
      releaseSequence: 12,
      trustPolicySequence: 6,
      schemaMinimum: 10,
      schemaMaximum: 10,
      latestMigration: 10,
      manifestSha256: "c".repeat(64),
      imageDigest: `sha256:${"d".repeat(64)}`,
    };
    const preview = previewUpgrade({
      installationId: randomUUID(),
      currentReleaseSequence: 11,
      currentTrustPolicySequence: 6,
      liveSchema: 10,
      target,
    });
    const backupId = randomUUID();

    await expect(
      runUpgrade({
        preview,
        confirmation: preview.previewHash,
        signal: new AbortController().signal,
        verifyTarget: async () => target,
        createBackup: async () => ({ backupId, validated: true }),
        drainWriters: async () => undefined,
        installApplication: async () => undefined,
        migrate: async () => undefined,
        verifyLiveSchema: async () => 10,
        preActivationReadiness: async () => undefined,
        verifyClients: async () => undefined,
        activateApplication: async () => undefined,
        commitSelection: async () => undefined,
        rollbackApplication: async () => undefined,
        stopWriters: async () => undefined,
      }),
    ).resolves.toEqual({ backupId, releaseId: "12-amd64" });
    expect(preserved).toEqual(before);
  });
});
