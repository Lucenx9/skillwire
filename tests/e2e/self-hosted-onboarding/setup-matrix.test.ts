import { describe, expect, it, vi } from "vitest";

import { runGuidedSetup } from "../../../src/onboarding/application/setup.js";

describe("guided setup client selection matrix", () => {
  it.each([
    ["none", []],
    ["codex", ["codex"]],
    ["claude", ["claude"]],
    ["codex,claude", ["codex", "claude"]],
  ] as const)(
    "keeps a healthy signed-release service for %s",
    async (selection, expected) => {
      const installed: string[] = [];
      const result = await runGuidedSetup(
        { clients: selection },
        {
          verifyRelease: vi.fn().mockResolvedValue({ releaseSequence: 1 }),
          installService: vi.fn().mockResolvedValue({
            installationId: "00000000-0000-4000-8000-000000000001",
            ready: true,
          }),
          installClient: (client) => {
            installed.push(client);
            return Promise.resolve({
              client,
              status: "verified" as const,
              compensated: false,
            });
          },
        },
      );
      expect(result.serviceReady).toBe(true);
      expect(result.status).toBe("success");
      expect(installed).toEqual(expected);
    },
  );

  it("compensates only a failed client and retains its verified sibling and service", async () => {
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
              ? { client, status: "verified" as const, compensated: false }
              : { client, status: "failed" as const, compensated: true },
          ),
      },
    );
    expect(result).toMatchObject({
      status: "incomplete",
      serviceReady: true,
      clients: [
        { client: "codex", status: "verified", compensated: false },
        { client: "claude", status: "failed", compensated: true },
      ],
    });
  });

  it("continues Claude when Codex compensates independently", async () => {
    const attempted: string[] = [];
    const result = await runGuidedSetup(
      { clients: "codex,claude" },
      {
        verifyRelease: vi.fn().mockResolvedValue({ releaseSequence: 1 }),
        installService: vi.fn().mockResolvedValue({
          installationId: "00000000-0000-4000-8000-000000000001",
          ready: true,
        }),
        installClient: (client) => {
          attempted.push(client);
          return Promise.resolve(
            client === "codex"
              ? { client, status: "failed" as const, compensated: true }
              : {
                  client,
                  status: "verified" as const,
                  compensated: false,
                },
          );
        },
      },
    );
    expect(attempted).toEqual(["codex", "claude"]);
    expect(result).toMatchObject({
      status: "incomplete",
      serviceReady: true,
      clients: [
        { client: "codex", status: "failed", compensated: true },
        { client: "claude", status: "verified", compensated: false },
      ],
    });
  });
});
