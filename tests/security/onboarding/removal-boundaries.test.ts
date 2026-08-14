/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production removal interfaces. */
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm as filesystemRm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import type * as FileSystemPromises from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemPromises>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

import {
  previewPurge,
  removeOwnedFilesystemTree,
  runPurge,
  validateOwnedFilesystemTree,
} from "../../../src/onboarding/application/purge.js";
import {
  createOwnershipLedger,
  reactivateOwnedAsset,
  recordAssetDisposition,
  recordOwnedAsset,
} from "../../../src/onboarding/domain/ownership.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

describe("removal ownership and filesystem boundaries", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("orders owned child assets before their containing path during purge", () => {
    let ledger = createOwnershipLedger(randomUUID());
    ledger = recordOwnedAsset(ledger, {
      kind: "path",
      client: null,
      locator: "/tmp/disposable/installations/example",
      expectedIdentitySha256: "1".repeat(64),
      createdByOperation: randomUUID(),
      retention: "remove-only-on-purge",
      disposition: "present",
    });
    ledger = recordOwnedAsset(ledger, {
      kind: "service-secret",
      client: null,
      locator: "example/secrets/database-password",
      expectedIdentitySha256: "2".repeat(64),
      createdByOperation: randomUUID(),
      retention: "retain-by-default",
      disposition: "present",
    });

    expect(
      previewPurge(ledger.record).unrecoverable.map(({ kind }) => kind),
    ).toEqual(["service-secret", "path"]);
  });

  it("refuses an unknown regular file inside an owned purge directory", async () => {
    fixture = await createOnboardingEnvironment();
    const owned = resolve(fixture.root, "owned");
    await mkdir(owned, { mode: 0o700 });
    const expected = resolve(owned, "expected.json");
    await writeFile(expected, "{}\n", { mode: 0o600 });
    await writeFile(resolve(owned, "unrelated.txt"), "do not remove", {
      mode: 0o600,
    });

    await expect(
      validateOwnedFilesystemTree(owned, fixture.root, [expected]),
    ).rejects.toThrow(/unknown|owned/i);
  });

  it.each(["drifted", "ambiguous"] as const)(
    "does not plan a %s owned asset",
    (disposition) => {
      let ledger = createOwnershipLedger(randomUUID());
      ledger = recordOwnedAsset(ledger, {
        kind: "path",
        client: null,
        locator: "owned/path",
        expectedIdentitySha256: "1".repeat(64),
        createdByOperation: randomUUID(),
        retention: "remove-only-on-purge",
        disposition: "present",
      });
      const assetId = ledger.record.assets[0]?.assetId;
      if (assetId === undefined) throw new Error("missing fixture asset");
      const changed = recordAssetDisposition(
        ledger.record,
        assetId,
        disposition,
      );
      expect(previewPurge(changed).unrecoverable).toEqual([]);
    },
  );

  it("revalidates identity and ownership revision before any removal", async () => {
    let ledger = createOwnershipLedger(randomUUID());
    ledger = recordOwnedAsset(ledger, {
      kind: "volume",
      client: null,
      locator: "skillwire-owned-volume",
      expectedIdentitySha256: "2".repeat(64),
      createdByOperation: randomUUID(),
      retention: "retain-by-default",
      disposition: "retained",
    });
    const preview = previewPurge(ledger.record);
    const removeAsset = vi.fn(async () => undefined);
    await expect(
      runPurge({
        ownership: ledger.record,
        preview,
        confirmation: preview.previewHash,
        signal: new AbortController().signal,
        observeIdentity: async () => "3".repeat(64),
        removeAsset,
      }),
    ).rejects.toThrow(/identity/i);
    expect(removeAsset).not.toHaveBeenCalled();

    const concurrent = recordAssetDisposition(
      ledger.record,
      ledger.record.assets[0]?.assetId ?? "",
      "retained",
    );
    await expect(
      runPurge({
        ownership: concurrent,
        preview,
        confirmation: preview.previewHash,
        signal: new AbortController().signal,
        observeIdentity: async (asset) => asset.expectedIdentitySha256,
        removeAsset,
      }),
    ).rejects.toThrow(/changed/i);
    expect(removeAsset).not.toHaveBeenCalled();
  });

  it("revalidates each purge asset immediately before deleting it", async () => {
    let ledger = createOwnershipLedger(randomUUID());
    for (const locator of ["skillwire-owned-one", "skillwire-owned-two"]) {
      ledger = recordOwnedAsset(ledger, {
        kind: "volume",
        client: null,
        locator,
        expectedIdentitySha256: "7".repeat(64),
        createdByOperation: randomUUID(),
        retention: "retain-by-default",
        disposition: "retained",
      });
    }
    const preview = previewPurge(ledger.record);
    let observations = 0;
    const removeAsset = vi.fn(async () => undefined);

    await expect(
      runPurge({
        ownership: ledger.record,
        preview,
        confirmation: preview.previewHash,
        signal: new AbortController().signal,
        observeIdentity: async (asset) => {
          observations += 1;
          return observations <= preview.unrecoverable.length ||
            asset.locator === "skillwire-owned-one"
            ? asset.expectedIdentitySha256
            : "8".repeat(64);
        },
        removeAsset,
      }),
    ).rejects.toThrow(/identity/i);
    expect(removeAsset).toHaveBeenCalledTimes(1);
  });

  it("rejects symlink traversal and leaves external targets unchanged", async () => {
    fixture = await createOnboardingEnvironment();
    const protectedRoot = resolve(fixture.root, "purge-root");
    const external = resolve(fixture.root, "external/keep.txt");
    await mkdir(protectedRoot, { mode: 0o700 });
    await mkdir(resolve(external, ".."), { recursive: true, mode: 0o700 });
    await writeFile(external, "keep", { mode: 0o600 });
    const link = resolve(protectedRoot, "owned-looking-link");
    await symlink(external, link);
    await expect(
      removeOwnedFilesystemTree(link, protectedRoot),
    ).rejects.toThrow(/unsafe|link/i);
    await expect(readFile(external, "utf8")).resolves.toBe("keep");
  });

  it("binds recursive deletion to a quarantined inode before a target-path substitution", async () => {
    fixture = await createOnboardingEnvironment();
    const protectedRoot = resolve(fixture.root, "purge-root");
    const owned = resolve(protectedRoot, "owned");
    const externalRoot = resolve(fixture.root, "external");
    const external = resolve(externalRoot, "keep.txt");
    await mkdir(owned, { recursive: true, mode: 0o700 });
    await mkdir(externalRoot, { mode: 0o700 });
    await writeFile(resolve(owned, "state.json"), "owned", { mode: 0o600 });
    await writeFile(external, "keep", { mode: 0o600 });
    const before = await lstat(owned, { bigint: true });
    const actual =
      await vi.importActual<typeof FileSystemPromises>("node:fs/promises");
    vi.mocked(filesystemRm).mockImplementationOnce(
      async (candidate, options) => {
        if (typeof candidate !== "string")
          throw new Error("expected a string purge target");
        expect(resolve(candidate)).not.toBe(owned);
        const quarantined = await lstat(candidate, { bigint: true });
        expect({ dev: quarantined.dev, ino: quarantined.ino }).toEqual({
          dev: before.dev,
          ino: before.ino,
        });
        await symlink(externalRoot, owned);
        await actual.rm(candidate, options);
      },
    );

    await removeOwnedFilesystemTree(owned, protectedRoot, [
      resolve(owned, "state.json"),
    ]);

    await expect(readFile(external, "utf8")).resolves.toBe("keep");
    await unlink(owned);
  });

  it("restores an identity-proven quarantine when recursive deletion fails", async () => {
    fixture = await createOnboardingEnvironment();
    const protectedRoot = resolve(fixture.root, "purge-root");
    const owned = resolve(protectedRoot, "owned");
    const ownedFile = resolve(owned, "state.json");
    await mkdir(owned, { recursive: true, mode: 0o700 });
    await writeFile(ownedFile, "owned", { mode: 0o600 });
    vi.mocked(filesystemRm).mockRejectedValueOnce(
      new Error("simulated recursive removal failure"),
    );

    await expect(
      removeOwnedFilesystemTree(owned, protectedRoot, [ownedFile]),
    ).rejects.toThrow(/restored|retry/i);

    await expect(readFile(ownedFile, "utf8")).resolves.toBe("owned");
    await expect(readdir(protectedRoot)).resolves.toEqual(["owned"]);
  });

  it("stops an interrupted purge before the first asset", async () => {
    let ledger = createOwnershipLedger(randomUUID());
    ledger = recordOwnedAsset(ledger, {
      kind: "backup",
      client: null,
      locator: "backups/one.dump",
      expectedIdentitySha256: "4".repeat(64),
      createdByOperation: randomUUID(),
      retention: "retain-by-default",
      disposition: "retained",
    });
    const preview = previewPurge(ledger.record);
    const controller = new AbortController();
    controller.abort();
    const removeAsset = vi.fn(async () => undefined);
    await expect(
      runPurge({
        ownership: ledger.record,
        preview,
        confirmation: preview.previewHash,
        signal: controller.signal,
        observeIdentity: async (asset) => asset.expectedIdentitySha256,
        removeAsset,
      }),
    ).rejects.toThrow(/cancel/i);
    expect(removeAsset).not.toHaveBeenCalled();
  });

  it("reactivates only an exact retained or removed owned asset", () => {
    let ledger = createOwnershipLedger(randomUUID());
    ledger = recordOwnedAsset(ledger, {
      kind: "credential",
      client: "codex",
      locator: "restrictive-file:codex:fixture",
      expectedIdentitySha256: "5".repeat(64),
      createdByOperation: randomUUID(),
      retention: "retain-by-default",
      disposition: "present",
    });
    const asset = ledger.record.assets[0];
    if (asset === undefined) throw new Error("missing fixture asset");
    const retained = recordAssetDisposition(
      ledger.record,
      asset.assetId,
      "retained",
    );
    expect(
      reactivateOwnedAsset(
        retained,
        asset.assetId,
        asset.expectedIdentitySha256,
      ).assets[0]?.disposition,
    ).toBe("present");
    expect(() =>
      reactivateOwnedAsset(retained, asset.assetId, "6".repeat(64)),
    ).toThrow(/identity/i);
  });
});
