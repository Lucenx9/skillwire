/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production lifecycle interfaces. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  previewPurge,
  removeOwnedFilesystemTree,
  runPurge,
} from "../../../src/onboarding/application/purge.js";
import { previewDefaultUninstall } from "../../../src/onboarding/application/uninstall.js";
import { ownedLauncherIdentity } from "../../../src/onboarding/application/production-setup.js";
import {
  createOwnershipLedger,
  recordOwnedAsset,
} from "../../../src/onboarding/domain/ownership.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

describe("separately confirmed permanent removal", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("binds a protected stable launcher to its exact owned bytes", async () => {
    fixture = await createOnboardingEnvironment();
    const launcher = resolve(fixture.root, "bin/skillwire");
    await mkdir(resolve(launcher, ".."), { recursive: true, mode: 0o700 });
    await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    await expect(ownedLauncherIdentity(launcher)).resolves.toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("binds confirmation to installation ID and exact owned targets", async () => {
    fixture = await createOnboardingEnvironment();
    const installationId = randomUUID();
    const ownedRoot = resolve(fixture.root, "owned");
    const dataPath = resolve(ownedRoot, "data");
    const backupPath = resolve(ownedRoot, "backups/validated.dump");
    const unrelatedPath = resolve(fixture.root, "unrelated/keep.txt");
    await mkdir(dataPath, { recursive: true, mode: 0o700 });
    await mkdir(resolve(backupPath, ".."), { recursive: true, mode: 0o700 });
    await mkdir(resolve(unrelatedPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(resolve(dataPath, "state.json"), "owned", { mode: 0o600 });
    await writeFile(backupPath, "backup", { mode: 0o600 });
    await writeFile(unrelatedPath, "keep", { mode: 0o600 });
    let ledger = createOwnershipLedger(installationId);
    for (const [kind, locator] of [
      ["path", dataPath],
      ["backup", backupPath],
    ] as const) {
      ledger = recordOwnedAsset(ledger, {
        kind,
        client: null,
        locator,
        expectedIdentitySha256: "e".repeat(64),
        createdByOperation: randomUUID(),
        retention: "remove-only-on-purge",
        disposition: "retained",
      });
    }
    const preview = previewPurge(ledger.record);
    expect(preview.installationId).toBe(installationId);
    expect(preview.unrecoverable.map(({ locator }) => locator).sort()).toEqual(
      [backupPath, dataPath].sort(),
    );
    const uninstallPreview = previewDefaultUninstall(ledger.record);
    const removeAsset = vi.fn(async (asset: { locator: string }) =>
      removeOwnedFilesystemTree(asset.locator, fixture?.root ?? ""),
    );

    await expect(
      runPurge({
        ownership: ledger.record,
        preview,
        confirmation: uninstallPreview.previewHash,
        signal: new AbortController().signal,
        observeIdentity: async (asset) => asset.expectedIdentitySha256,
        removeAsset,
      }),
    ).rejects.toThrow(/preview/i);
    expect(removeAsset).not.toHaveBeenCalled();

    const result = await runPurge({
      ownership: ledger.record,
      preview,
      confirmation: preview.previewHash,
      signal: new AbortController().signal,
      observeIdentity: async (asset) => asset.expectedIdentitySha256,
      removeAsset,
    });
    expect(result.removed).toHaveLength(2);
    await expect(readFile(dataPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(backupPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(unrelatedPath, "utf8")).resolves.toBe("keep");
  });
});
