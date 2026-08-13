import { describe, expect, it, vi } from "vitest";

import {
  clientConflictFinding,
  evaluateClientLifecycleAction,
  installClientLifecycle,
} from "../../../src/onboarding/application/client-lifecycle.js";
import { runGuidedSetup } from "../../../src/onboarding/application/setup.js";

describe("client-local conflicts and partial dual-client success", () => {
  it.each([
    "same-name-conflict",
    "ambiguous",
    "duplicate",
    "shadowed",
    "managed",
    "drifted-owned",
  ] as const)(
    "blocks %s without mutation and emits stable redacted output",
    (state) => {
      expect(evaluateClientLifecycleAction("setup", state)).toEqual({
        action: "block",
        mutable: false,
      });
      const finding = clientConflictFinding("codex", "mcp-entry", state, {
        scope: "project",
        identitySha256: "a".repeat(64),
      });
      expect(finding).toMatchObject({
        code: "CLIENT_INTEGRATION_CONFLICT",
        client: "codex",
        component: "mcp-entry",
        classification: state,
      });
      expect(JSON.stringify(finding)).not.toMatch(/profile-canary|\/home\//i);
    },
  );

  it("does not provision or compensate a client blocked before mutation", async () => {
    const mutation = vi.fn();
    const result = await installClientLifecycle("codex", {
      preflight: () =>
        Promise.resolve({
          action: "block" as const,
          classification: "same-name-conflict" as const,
        }),
      provisionCredential: mutation,
      addMcp: mutation,
      addPlugin: mutation,
      verify: mutation,
      removePlugin: mutation,
      removeMcp: mutation,
      revokeCredential: mutation,
    });
    expect(result).toMatchObject({
      status: "failed",
      compensated: false,
      owned: false,
    });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("retains a successful sibling and service when the other client is blocked", async () => {
    const result = await runGuidedSetup(
      { clients: "codex,claude" },
      {
        verifyRelease: vi.fn().mockResolvedValue({ releaseSequence: 1 }),
        installService: vi.fn().mockResolvedValue({
          installationId: "00000000-0000-4000-8000-000000000001",
          ready: true,
        }),
        installClient: (client) =>
          Promise.resolve(
            client === "codex"
              ? {
                  client,
                  status: "failed" as const,
                  compensated: false,
                  owned: false,
                }
              : {
                  client,
                  status: "verified" as const,
                  compensated: false,
                  owned: true,
                },
          ),
      },
    );
    expect(result).toMatchObject({
      status: "incomplete",
      serviceReady: true,
      clients: [
        { client: "codex", status: "failed", compensated: false },
        { client: "claude", status: "verified", compensated: false },
      ],
    });
  });
});
