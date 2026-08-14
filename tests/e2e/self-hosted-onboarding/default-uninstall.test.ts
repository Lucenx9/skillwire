/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production lifecycle interfaces. */
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  previewDefaultUninstall,
  runDefaultUninstall,
} from "../../../src/onboarding/application/uninstall.js";
import { uninstallClientLifecycle } from "../../../src/onboarding/application/client-lifecycle.js";
import {
  createOwnershipLedger,
  planOwnedAssetDispositions,
  recordAssetDisposition,
  recordOwnedAsset,
} from "../../../src/onboarding/domain/ownership.js";

describe("data-preserving default uninstall", () => {
  it("removes only owned client/service runtime assets and retains recovery state", async () => {
    const installationId = randomUUID();
    const operationId = randomUUID();
    let ledger = createOwnershipLedger(installationId);
    const assets = [
      ["mcp-entry", "codex", "skillwire:user", "remove-on-uninstall"],
      ["plugin", "codex", "skillwire-plugin", "remove-on-uninstall"],
      ["marketplace", "claude", "skillwire-marketplace", "remove-on-uninstall"],
      ["credential", "codex", "secret-service:codex", "retain-by-default"],
      ["container", null, "skillwire-service", "remove-on-uninstall"],
      ["compose-project", null, "skillwire-project", "remove-on-uninstall"],
      ["volume", null, "skillwire-volume", "retain-by-default"],
      ["backup", null, "backups/backup.dump", "retain-by-default"],
      [
        "service-secret",
        null,
        "secrets/database-password",
        "retain-by-default",
      ],
      ["release", null, "releases/skillwire-1", "retain-by-default"],
      ["trust-policy", null, "trust/policy-v1.json", "retain-by-default"],
      ["path", null, "state/installation.json", "remove-only-on-purge"],
    ] as const;
    for (const [kind, client, locator, retention] of assets) {
      ledger = recordOwnedAsset(ledger, {
        kind,
        client,
        locator,
        expectedIdentitySha256: "a".repeat(64),
        createdByOperation: operationId,
        retention,
        disposition: "present",
      });
    }
    const preview = previewDefaultUninstall(ledger.record);
    const removed: string[] = [];
    const unrelatedExternal = {
      codexMcp: "external-command",
      claudePlugin: "external-plugin",
      profileSetting: "keep",
    };
    const beforeExternal = structuredClone(unrelatedExternal);
    const stopOwnedService = vi.fn(async () => undefined);

    const result = await runDefaultUninstall({
      ownership: ledger.record,
      preview,
      confirmation: preview.previewHash,
      signal: new AbortController().signal,
      observeIdentity: async (asset) => asset.expectedIdentitySha256,
      removeAsset: async (asset) => {
        removed.push(asset.kind);
      },
      stopOwnedService,
      publishRetained: async () => undefined,
    });

    expect(removed.sort()).toEqual(
      [
        "compose-project",
        "container",
        "marketplace",
        "mcp-entry",
        "plugin",
      ].sort(),
    );
    expect(preview.retain.map(({ kind }) => kind).sort()).toEqual(
      [
        "backup",
        "credential",
        "path",
        "release",
        "service-secret",
        "trust-policy",
        "volume",
      ].sort(),
    );
    expect(stopOwnedService).toHaveBeenCalledTimes(1);
    expect(result.retained).toHaveLength(7);
    expect(unrelatedExternal).toEqual(beforeExternal);
  });

  it("uninstalls one owned client including its key while preserving its sibling and external integrations", async () => {
    const events: string[] = [];
    const result = await uninstallClientLifecycle(
      "codex",
      {
        inspect: async () => [
          {
            component: "mcp-entry",
            classification: "owned-equivalent",
            expectedIdentitySha256: "b".repeat(64),
            currentIdentitySha256: "b".repeat(64),
          },
          {
            component: "plugin",
            classification: "external-equivalent",
            expectedIdentitySha256: null,
            currentIdentitySha256: "c".repeat(64),
          },
          {
            component: "credential",
            classification: "owned-equivalent",
            expectedIdentitySha256: "d".repeat(64),
            currentIdentitySha256: "d".repeat(64),
          },
        ],
        removeMcp: async () => {
          events.push("codex-mcp");
        },
        removePlugin: async () => {
          events.push("codex-plugin");
        },
        removeMarketplace: async () => {
          events.push("codex-marketplace");
        },
        revokeCredential: async () => {
          events.push("codex-key-and-credential");
        },
        verifyAbsent: async () => true,
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      client: "codex",
      status: "removed",
      removed: ["mcp-entry", "credential"],
      retainedExternal: ["plugin"],
    });
    expect(events).toEqual(["codex-mcp", "codex-key-and-credential"]);
    expect(events.some((event) => event.includes("claude"))).toBe(false);
  });

  it("still plans an independently revocable retained client credential after default uninstall", () => {
    let ledger = createOwnershipLedger(randomUUID());
    ledger = recordOwnedAsset(ledger, {
      kind: "credential",
      client: "claude",
      locator: "restrictive-file:claude:fixture",
      expectedIdentitySha256: "e".repeat(64),
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
      planOwnedAssetDispositions(retained, "client-uninstall", "claude").remove,
    ).toEqual([expect.objectContaining({ assetId: asset.assetId })]);
  });
});
