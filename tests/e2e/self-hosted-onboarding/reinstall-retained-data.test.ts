/* eslint-disable @typescript-eslint/require-await, prefer-const -- Async fakes mirror production interfaces; the closure-backed result is assigned after dependency construction. */
import { describe, expect, it, vi } from "vitest";

import {
  runGuidedSetup,
  type GuidedSetupResult,
} from "../../../src/onboarding/application/setup.js";

describe("retained-data reinstall", () => {
  it("reuses installation, account, volume, secrets, and keys while restoring each client registration once", async () => {
    const installationId = "00000000-0000-4000-8000-000000000129";
    const writes = {
      account: 0,
      volume: 0,
      serviceSecrets: 0,
      keys: 0,
      mcp: 0,
      plugins: 0,
    };
    let completed: GuidedSetupResult | undefined;
    const dependencies = {
      inspectExisting: vi.fn(async () => completed),
      verifyRelease: vi.fn(async () => ({ releaseSequence: 12 })),
      discoverRetained: vi.fn(async () =>
        completed === undefined ? { installationId, clients: [] } : undefined,
      ),
      reactivateRetainedService: vi.fn(async () => ({ ready: true })),
      reactivateClient: vi.fn(async (client: "codex" | "claude") => {
        writes.mcp += 1;
        writes.plugins += 1;
        return {
          client,
          status: "verified" as const,
          compensated: false,
          owned: true,
        };
      }),
      installService: vi.fn(async () => {
        writes.account += 1;
        writes.volume += 1;
        writes.serviceSecrets += 1;
        return { installationId: "new-installation", ready: true };
      }),
      installClient: vi.fn(async (client: "codex" | "claude") => {
        writes.keys += 1;
        return { client, status: "verified" as const, compensated: false };
      }),
    };

    completed = await runGuidedSetup({ clients: "codex,claude" }, dependencies);
    const repeated = await runGuidedSetup(
      { clients: "codex,claude" },
      dependencies,
    );

    expect(completed.installationId).toBe(installationId);
    expect(repeated).toEqual(completed);
    expect(writes).toEqual({
      account: 0,
      volume: 0,
      serviceSecrets: 0,
      keys: 0,
      mcp: 2,
      plugins: 2,
    });
    expect(dependencies.reactivateRetainedService).toHaveBeenCalledTimes(1);
    expect(dependencies.reactivateClient).toHaveBeenCalledTimes(2);
    expect(dependencies.installService).not.toHaveBeenCalled();
    expect(dependencies.installClient).not.toHaveBeenCalled();
  });
});
