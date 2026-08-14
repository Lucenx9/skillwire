import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";

import { runBridgeLifecycle } from "../../../src/credential-bridge/bridge-cli.js";

describe("credential bridge end-to-end deadline", () => {
  it("bounds process-start through credential lookup, upstream validation, and STDIO readiness with one attempt", async () => {
    const started = performance.now();
    let attempts = 0;
    await expect(
      runBridgeLifecycle(
        {
          installationId: "00000000-0000-4000-8000-000000000001",
          client: "codex",
          startedAt: started,
          deadlineMilliseconds: 50,
        },
        {
          resolve: async () => {
            attempts += 1;
            await new Promise(() => undefined);
            throw new Error("unreachable");
          },
          connect: () => Promise.reject(new Error("must not connect")),
          serve: () => Promise.reject(new Error("must not serve")),
        },
      ),
    ).rejects.toThrow(/deadline/i);
    expect(performance.now() - started).toBeLessThan(500);
    expect(attempts).toBe(1);
  });

  it("completes a successful fresh lifecycle once within the total budget", async () => {
    const started = performance.now();
    let resolved = 0;
    let connected = 0;
    let served = 0;
    await runBridgeLifecycle(
      {
        installationId: "00000000-0000-4000-8000-000000000001",
        client: "claude",
        startedAt: started,
        deadlineMilliseconds: 1_000,
      },
      {
        resolve: () => {
          resolved += 1;
          return Promise.resolve({
            endpoint: new URL("http://127.0.0.1:3000/mcp"),
            socketPath: "/tmp/disposable/mcp.sock",
            token: "fixture",
          });
        },
        connect: () => {
          connected += 1;
          return Promise.resolve({
            client: new Client({ name: "deadline-fixture", version: "1.0.0" }),
            instructions: "fixture",
            tools: [],
            close: () => Promise.resolve(),
          });
        },
        serve: (_connection, _signal, ready) => {
          served += 1;
          ready();
          return Promise.resolve();
        },
      },
    );
    expect([resolved, connected, served]).toEqual([1, 1, 1]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("applies the deadline only through STDIO readiness and then serves until cancellation", async () => {
    const started = performance.now();
    const caller = new AbortController();
    let closed = 0;
    const cancellation = setTimeout(() => {
      caller.abort();
    }, 75);

    await runBridgeLifecycle(
      {
        installationId: "00000000-0000-4000-8000-000000000001",
        client: "codex",
        startedAt: started,
        deadlineMilliseconds: 25,
        signal: caller.signal,
      },
      {
        resolve: () =>
          Promise.resolve({
            endpoint: new URL("http://127.0.0.1:3000/mcp"),
            socketPath: "/tmp/disposable/mcp.sock",
            token: "fixture",
          }),
        connect: () =>
          Promise.resolve({
            client: new Client({ name: "deadline-fixture", version: "1.0.0" }),
            instructions: "fixture",
            tools: [],
            close: () => {
              closed += 1;
              return Promise.resolve();
            },
          }),
        serve: (_connection, signal, ready) => {
          ready();
          return new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
          });
        },
      },
    );
    clearTimeout(cancellation);

    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    expect(closed).toBe(1);
  });
});
