import { describe, expect, it, vi } from "vitest";

import { installClientLifecycle } from "../../../src/onboarding/application/client-lifecycle.js";

describe("independent client lifecycle transaction", () => {
  it("persists and verifies a distinct credential before native manager changes", async () => {
    const order: string[] = [];
    const result = await installClientLifecycle("codex", {
      preflight: () => Promise.resolve(),
      provisionCredential: () => {
        order.push("credential");
        return Promise.resolve({
          keyId: "key-id",
          reference: "secret-service:codex",
        });
      },
      addMcp: () => {
        order.push("mcp");
        return Promise.resolve();
      },
      addPlugin: () => {
        order.push("plugin");
        return Promise.resolve();
      },
      verify: () => {
        order.push("verify");
        return Promise.resolve();
      },
      removePlugin: vi.fn(),
      removeMcp: vi.fn(),
      revokeCredential: vi.fn(),
    });
    expect(order).toEqual(["credential", "mcp", "plugin", "verify"]);
    expect(result.status).toBe("verified");
  });

  it("compensates in reverse and revokes only the newly created key", async () => {
    const compensated: string[] = [];
    const result = await installClientLifecycle("claude", {
      preflight: () => Promise.resolve(),
      provisionCredential: () =>
        Promise.resolve({
          keyId: "new-key",
          reference: "restrictive-file:claude",
        }),
      addMcp: () => Promise.resolve(),
      addPlugin: () => Promise.resolve(),
      verify: () => Promise.reject(new Error("injected verification failure")),
      removePlugin: () => {
        compensated.push("plugin");
        return Promise.resolve();
      },
      removeMcp: () => {
        compensated.push("mcp");
        return Promise.resolve();
      },
      revokeCredential: (keyId) => {
        compensated.push(`credential:${keyId}`);
        return Promise.resolve();
      },
    });
    expect(result).toMatchObject({ status: "failed", compensated: true });
    expect(compensated).toEqual(["plugin", "mcp", "credential:new-key"]);
  });

  it.each(["mcp", "plugin"] as const)(
    "runs the narrow inverse when %s mutates and then fails readback",
    async (failingStep) => {
      const compensated: string[] = [];
      const result = await installClientLifecycle("codex", {
        preflight: () => Promise.resolve(),
        provisionCredential: () =>
          Promise.resolve({
            keyId: "new-key",
            reference: "restrictive-file:codex",
          }),
        addMcp: () =>
          failingStep === "mcp"
            ? Promise.reject(new Error("MCP mutated before readback failed"))
            : Promise.resolve(),
        addPlugin: () =>
          Promise.reject(new Error("plugin mutated before readback failed")),
        verify: () => Promise.resolve(),
        removePlugin: () => {
          compensated.push("plugin");
          return Promise.resolve();
        },
        removeMcp: () => {
          compensated.push("mcp");
          return Promise.resolve();
        },
        revokeCredential: () => {
          compensated.push("credential");
          return Promise.resolve();
        },
      });

      expect(result).toMatchObject({ status: "failed", compensated: true });
      expect(compensated).toEqual(
        failingStep === "mcp"
          ? ["mcp", "credential"]
          : ["plugin", "mcp", "credential"],
      );
    },
  );
});
