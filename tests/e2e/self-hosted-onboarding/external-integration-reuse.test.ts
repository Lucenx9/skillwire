import { describe, expect, it, vi } from "vitest";

import {
  evaluateClientLifecycleAction,
  installClientLifecycle,
} from "../../../src/onboarding/application/client-lifecycle.js";
import {
  createOwnershipLedger,
  recordExternalIntegration,
  recordOwnedAsset,
  verifyOwnershipRecord,
} from "../../../src/onboarding/domain/ownership.js";

describe("equivalent external integration reuse", () => {
  it.each(["setup", "repair", "upgrade", "uninstall", "purge"] as const)(
    "%s reuses external state without ownership or mutation",
    (operation) => {
      expect(
        evaluateClientLifecycleAction(operation, "external-equivalent"),
      ).toEqual({ action: "reuse-external", mutable: false });
    },
  );

  it.each(["uninstall", "purge"] as const)(
    "%s treats an absent component as an immutable no-op",
    (operation) => {
      expect(evaluateClientLifecycleAction(operation, "absent")).toEqual({
        action: "no-op",
        mutable: false,
      });
    },
  );

  it("creates no key, duplicate, or inverse operation for a fully external integration", async () => {
    const calls = {
      credential: vi.fn(),
      addMcp: vi.fn(),
      addPlugin: vi.fn(),
      removeMcp: vi.fn(),
      removePlugin: vi.fn(),
      revoke: vi.fn(),
      verify: vi.fn().mockResolvedValue(undefined),
    };
    const result = await installClientLifecycle("codex", {
      preflight: () =>
        Promise.resolve({
          action: "reuse-external" as const,
          mcp: "reuse-external" as const,
          plugin: "reuse-external" as const,
        }),
      provisionCredential: calls.credential,
      addMcp: calls.addMcp,
      addPlugin: calls.addPlugin,
      verify: calls.verify,
      removePlugin: calls.removePlugin,
      removeMcp: calls.removeMcp,
      revokeCredential: calls.revoke,
    });

    expect(result).toMatchObject({
      status: "external-verified",
      compensated: false,
      owned: false,
    });
    expect(calls.verify).toHaveBeenCalledOnce();
    for (const mutation of [
      calls.credential,
      calls.addMcp,
      calls.addPlugin,
      calls.removeMcp,
      calls.removePlugin,
      calls.revoke,
    ]) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it("records external dependencies without converting them to owned assets", () => {
    const ledger = recordExternalIntegration(
      createOwnershipLedger("00000000-0000-4000-8000-000000000001"),
      {
        schemaVersion: "skillwire.external-integration/v1",
        externalDependencyId: "00000000-0000-4000-8000-000000000002",
        client: "codex",
        kind: "mcp-entry",
        scope: "user",
        observedIdentitySha256: "a".repeat(64),
        verification: "equivalent",
        lastObservedAt: "2026-08-14T00:00:00.000Z",
      },
    );
    expect(ledger.record.assets).toEqual([]);
    expect(ledger.record.externalDependencies).toEqual([
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(ledger.record.recordRevision).toBe(2);
    expect(ledger.record.recordSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyOwnershipRecord(ledger.record)).toEqual(ledger.record);
    expect(() =>
      recordOwnedAsset(ledger, {
        kind: "mcp-entry",
        client: "codex",
        locator: "skillwire:user",
        expectedIdentitySha256: "a".repeat(64),
        createdByOperation: "00000000-0000-4000-8000-000000000003",
        retention: "remove-on-uninstall",
        disposition: "present",
      }),
    ).toThrow(/both external and owned/i);
  });
});
