/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production lifecycle interfaces. */
import { describe, expect, it, vi } from "vitest";

import {
  runGuidedSetup,
  type GuidedSetupResult,
} from "../../../src/onboarding/application/setup.js";
import {
  runRepeatedSetupClientVerification,
  unchangedSetupClientResults,
} from "../../../src/onboarding/application/production-setup.js";

describe("unchanged guided setup", () => {
  it("preserves external ownership classification in the production no-op result", () => {
    const installationId = "00000000-0000-4000-8000-000000000009";
    expect(
      unchangedSetupClientResults(["codex", "claude"], installationId, {
        schemaVersion: "skillwire.client-integrations/v1",
        installationId,
        integrations: [
          integration(installationId, "codex", "external-verified"),
          integration(installationId, "claude", "verified"),
        ],
      }),
    ).toMatchObject([
      { client: "codex", status: "external-verified", owned: false },
      { client: "claude", status: "verified", owned: true },
    ]);
  });

  it("does not adopt a credential for an equivalent external integration", async () => {
    const verifyManaged = vi.fn(async () => undefined);
    const verifyExternal = vi.fn(async () => undefined);

    await runRepeatedSetupClientVerification("external-verified", {
      verifyManaged,
      verifyExternal,
    });

    expect(verifyManaged).not.toHaveBeenCalled();
    expect(verifyExternal).toHaveBeenCalledOnce();
  });

  it("is a byte-for-byte no-op for ten repeated executions", async () => {
    let installed: GuidedSetupResult | undefined;
    const writes = {
      account: 0,
      key: 0,
      volume: 0,
      serviceSecret: 0,
      source: 0,
      plugin: 0,
      mcp: 0,
    };
    const dependencies = {
      inspectExisting: vi.fn(async () => installed),
      verifyRelease: vi.fn(async () => ({ releaseSequence: 9 })),
      installService: vi.fn(async () => {
        writes.account += 1;
        writes.volume += 1;
        writes.serviceSecret += 1;
        return {
          installationId: "00000000-0000-4000-8000-000000000009",
          ready: true,
        };
      }),
      installClient: vi.fn(async (client: "codex" | "claude") => {
        writes.key += 1;
        writes.plugin += 1;
        writes.mcp += 1;
        return {
          client,
          status: "verified" as const,
          compensated: false,
        };
      }),
    };

    for (let run = 0; run < 10; run += 1) {
      const result = await runGuidedSetup(
        { clients: "codex,claude" },
        dependencies,
      );
      installed ??= result;
      expect(result).toEqual(installed);
    }

    expect(writes).toEqual({
      account: 1,
      key: 2,
      volume: 1,
      serviceSecret: 1,
      source: 0,
      plugin: 2,
      mcp: 2,
    });
    expect(dependencies.verifyRelease).toHaveBeenCalledTimes(1);
    expect(dependencies.installService).toHaveBeenCalledTimes(1);
    expect(dependencies.installClient).toHaveBeenCalledTimes(2);
  });
});

function integration(
  installationId: string,
  client: "codex" | "claude",
  state: "verified" | "external-verified",
) {
  return {
    schemaVersion: "skillwire.client-integration/v1",
    clientIntegrationId:
      client === "codex"
        ? "00000000-0000-4000-8000-000000000010"
        : "00000000-0000-4000-8000-000000000011",
    installationId,
    client,
    clientVersion: "0.147.0",
    profileScope: "normal-user",
    state,
    credentialReferenceId: null,
    keyPublicIdHash: null,
    mcpIdentitySha256: "a".repeat(64),
    adapterIdentitySha256: "b".repeat(64),
  };
}
