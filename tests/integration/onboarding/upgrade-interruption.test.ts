/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-confusing-void-expression -- Async fakes mirror production upgrade interfaces. */
import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  upgradeFailureRequiresRecovery,
  previewUpgrade,
  runUpgrade,
} from "../../../src/onboarding/application/upgrade.js";
import { commitActiveReleaseSelection } from "../../../src/onboarding/adapters/filesystem/release-installer.js";
import { OperationJournal } from "../../../src/onboarding/domain/operation-journal.js";
import { createOnboardingEnvironment } from "../../helpers/onboarding-environment.js";

describe("upgrade interruption boundaries", () => {
  it("keeps a failed final publication journal recoverable after an unproven effect", () => {
    expect(upgradeFailureRequiresRecovery(false, true)).toBe(true);
    expect(upgradeFailureRequiresRecovery(false, false)).toBe(false);
    expect(upgradeFailureRequiresRecovery(true, false)).toBe(true);
  });

  it.each([
    "release-verification",
    "backup",
    "drain",
    "migration",
    "readiness",
    "clients",
  ] as const)("stops safely after %s cancellation", async (boundary) => {
    const target = {
      releaseId: "10-amd64",
      releaseSequence: 10,
      trustPolicySequence: 3,
      schemaMinimum: 9,
      schemaMaximum: 10,
      latestMigration: 10,
      manifestSha256: "3".repeat(64),
      imageDigest: `sha256:${"4".repeat(64)}`,
    };
    const preview = previewUpgrade({
      installationId: randomUUID(),
      currentReleaseSequence: 9,
      currentTrustPolicySequence: 3,
      liveSchema: 9,
      target,
    });
    const controller = new AbortController();
    const reached: string[] = [];
    const at = async <T>(name: string, value: T): Promise<T> => {
      reached.push(name);
      if (boundary === name) controller.abort();
      return value;
    };

    await expect(
      runUpgrade({
        preview,
        confirmation: preview.previewHash,
        signal: controller.signal,
        verifyTarget: () => at("release-verification", target),
        createBackup: () =>
          at("backup", { backupId: randomUUID(), validated: true }),
        drainWriters: () => at("drain", undefined),
        installApplication: () => at("application", undefined),
        migrate: () => at("migration", undefined),
        verifyLiveSchema: async () => 10,
        readiness: () => at("readiness", undefined),
        verifyClients: () => at("clients", undefined),
        commitSelection: () => at("release-commit", undefined),
        rollbackApplication: vi.fn(async () => undefined),
        stopWriters: vi.fn(async () => undefined),
        restartWriters: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(/cancel|upgrade|recovery|boundary/i);
    expect(reached).toContain(boundary);
    const order = [
      "release-verification",
      "backup",
      "drain",
      "application",
      "migration",
      "readiness",
      "clients",
      "release-commit",
    ];
    const boundaryIndex = order.indexOf(boundary);
    expect(reached.some((name) => order.indexOf(name) > boundaryIndex)).toBe(
      false,
    );
  });

  it("treats a completed atomic release commit as the terminal success boundary", async () => {
    const target = {
      releaseId: "10-amd64",
      releaseSequence: 10,
      trustPolicySequence: 3,
      schemaMinimum: 10,
      schemaMaximum: 10,
      latestMigration: 10,
      manifestSha256: "3".repeat(64),
      imageDigest: `sha256:${"4".repeat(64)}`,
    };
    const preview = previewUpgrade({
      installationId: randomUUID(),
      currentReleaseSequence: 9,
      currentTrustPolicySequence: 3,
      liveSchema: 10,
      target,
    });
    const controller = new AbortController();
    await expect(
      runUpgrade({
        preview,
        confirmation: preview.previewHash,
        signal: controller.signal,
        verifyTarget: async () => target,
        createBackup: async () => ({
          backupId: randomUUID(),
          validated: true,
        }),
        drainWriters: async () => undefined,
        installApplication: async () => undefined,
        migrate: async () => undefined,
        verifyLiveSchema: async () => 10,
        readiness: async () => undefined,
        verifyClients: async () => undefined,
        commitSelection: async () => controller.abort(),
        rollbackApplication: vi.fn(),
        stopWriters: vi.fn(),
        restartWriters: vi.fn(),
      }),
    ).resolves.toMatchObject({ releaseId: "10-amd64" });
  });

  it("publishes active release/trust selection as one journaled atomic effect", async () => {
    const fixture = await createOnboardingEnvironment();
    try {
      const stateRoot = resolve(fixture.root, "state");
      await mkdir(stateRoot, { mode: 0o700 });
      const journal = await OperationJournal.create(
        resolve(stateRoot, "operations"),
        randomUUID(),
        "upgrade",
      );
      await commitActiveReleaseSelection({
        stateRoot,
        journal,
        signal: new AbortController().signal,
        selection: {
          schemaVersion: "skillwire.active-release/v1",
          releaseVersion: "1.2.0",
          releaseSequence: 12,
          trustPolicySequence: 6,
          architecture: "amd64",
          manifestSha256: "7".repeat(64),
          archiveSha256: "8".repeat(64),
          trustPolicyPath: "trust/skillwire-trust-policy-v6.json",
        },
      });
      expect(journal.entries.map(({ phase }) => phase)).toEqual([
        "intent",
        "effect",
        "verify",
      ]);
      expect(
        JSON.parse(
          await readFile(resolve(stateRoot, "active-release.json"), "utf8"),
        ),
      ).toMatchObject({ releaseSequence: 12, trustPolicySequence: 6 });
    } finally {
      await fixture.close();
    }
  });
});
