import { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { runBridgeLifecycle } from "../../../src/credential-bridge/bridge-cli.js";

describe("bounded fail-open activation", () => {
  it.each(["resolve", "connect", "serve"] as const)(
    "makes one %s attempt with no retry, reconnect, or prompt",
    async (failureStage) => {
      const attempts = { resolve: 0, connect: 0, serve: 0 };
      const startedAt = performance.now();
      await expect(
        runBridgeLifecycle(
          {
            installationId: "00000000-0000-4000-8000-000000000001",
            client: "claude",
            startedAt,
            deadlineMilliseconds: 250,
          },
          {
            resolve: () => {
              attempts.resolve += 1;
              return failureStage === "resolve"
                ? Promise.reject(new Error("unavailable"))
                : Promise.resolve({
                    endpoint: new URL("http://127.0.0.1:3000/mcp"),
                    token: "fixture",
                  });
            },
            connect: () => {
              attempts.connect += 1;
              return failureStage === "connect"
                ? Promise.reject(new Error("unreachable"))
                : Promise.resolve({
                    client: new Client({ name: "bounded", version: "1" }),
                    instructions: "fixture",
                    tools: [],
                    close: () => Promise.resolve(),
                  });
            },
            serve: () => {
              attempts.serve += 1;
              return Promise.reject(new Error("closed"));
            },
          },
        ),
      ).rejects.toThrow();
      expect(attempts).toEqual({
        resolve: 1,
        connect: failureStage === "resolve" ? 0 : 1,
        serve: failureStage === "serve" ? 1 : 0,
      });
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(JSON.stringify(attempts)).not.toMatch(/prompt|retry|reconnect/i);
    },
  );

  it("cancels a pending readiness attempt without a second attempt", async () => {
    const caller = new AbortController();
    const serve = vi.fn(
      (_connection, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("cancelled"));
            },
            {
              once: true,
            },
          );
        }),
    );
    const pending = runBridgeLifecycle(
      {
        installationId: "00000000-0000-4000-8000-000000000001",
        client: "codex",
        startedAt: performance.now(),
        deadlineMilliseconds: 500,
        signal: caller.signal,
      },
      {
        resolve: () =>
          Promise.resolve({
            endpoint: new URL("http://127.0.0.1:3000/mcp"),
            token: "fixture",
          }),
        connect: () =>
          Promise.resolve({
            client: new Client({ name: "cancel", version: "1" }),
            instructions: "fixture",
            tools: [],
            close: () => Promise.resolve(),
          }),
        serve,
      },
    );
    await vi.waitFor(() => {
      expect(serve).toHaveBeenCalledOnce();
    });
    caller.abort();
    await expect(pending).rejects.toThrow(/cancel/i);
    expect(serve).toHaveBeenCalledOnce();
  });
});
