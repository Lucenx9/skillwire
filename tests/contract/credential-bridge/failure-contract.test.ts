import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
  BridgeFailure,
  bridgeFailureReport,
  normalizeBridgeFailure,
} from "../../../src/credential-bridge/bridge-errors.js";
import { runBridgeLifecycle } from "../../../src/credential-bridge/bridge-cli.js";
import { createStdioProxyServer } from "../../../src/credential-bridge/stdio-server.js";

describe("credential bridge stable fail-open contract", () => {
  it.each([
    ["state", "BRIDGE_STATE_UNAVAILABLE"],
    ["endpoint", "BRIDGE_ENDPOINT_INVALID"],
    ["credential", "BRIDGE_CREDENTIAL_UNAVAILABLE"],
    ["auth", "BRIDGE_AUTH_REJECTED"],
    ["contract", "BRIDGE_CONTRACT_INVALID"],
    ["timeout", "BRIDGE_DEADLINE_EXCEEDED"],
    ["cancellation", "BRIDGE_CANCELLED"],
    ["transport", "BRIDGE_TRANSPORT_UNAVAILABLE"],
  ] as const)("maps %s failures to stable redacted output", (kind, code) => {
    const canary =
      "swk.abcdefghijklmnop.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const report = bridgeFailureReport(
      normalizeBridgeFailure(
        new Error(`private ${canary} /home/private`),
        kind,
      ),
    );
    expect(report).toMatchObject({ code });
    expect(JSON.stringify(report)).not.toMatch(
      /swk\.|\/home\/private|private/i,
    );
  });

  it("closes an initialized upstream once after serving fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    await expect(
      runBridgeLifecycle(
        {
          installationId: "00000000-0000-4000-8000-000000000001",
          client: "codex",
          startedAt: performance.now(),
          deadlineMilliseconds: 500,
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
              client: new Client({ name: "failure-fixture", version: "1" }),
              instructions: "fixture",
              tools: [],
              close,
            }),
          serve: (_connection, _signal, ready) => {
            ready();
            return Promise.reject(
              new BridgeFailure("BRIDGE_TRANSPORT_UNAVAILABLE"),
            );
          },
        },
      ),
    ).rejects.toMatchObject({ code: "BRIDGE_TRANSPORT_UNAVAILABLE" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("maps thrown upstream details to a stable safe MCP error", async () => {
    const upstreamClient = new Client({ name: "upstream", version: "1" });
    vi.spyOn(upstreamClient, "listTools").mockRejectedValue(
      new Error(
        "transport swk.abcdefghijklmnop.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA /home/private",
      ),
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const proxy = createStdioProxyServer(
      {
        client: upstreamClient,
        instructions: "fixture",
        tools: [],
        close: () => Promise.resolve(),
      },
      new AbortController().signal,
    );
    await proxy.connect(serverTransport);
    const downstream = new Client({ name: "downstream", version: "1" });
    await downstream.connect(clientTransport);
    const failure = await downstream.listTools().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "BRIDGE_TRANSPORT_UNAVAILABLE",
    );
    expect((failure as Error).message).not.toMatch(/swk\.|\/home\/private/);
    await downstream.close();
    await proxy.close();
  });
});
