import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestApplication } from "../../../src/composition.js";
import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import { ACTIVATION_INSTRUCTIONS } from "../../../src/transport/mcp/activation-policy.js";
import {
  connectUpstream,
  type UpstreamConnection,
} from "../../../src/credential-bridge/upstream-client.js";
import { createStdioProxyServer } from "../../../src/credential-bridge/stdio-server.js";
import { FakeRepositoryMemoryStore } from "../../helpers/memory-store.js";

describe("transparent STDIO-to-loopback HTTP bridge", () => {
  let upstream: UpstreamConnection | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await upstream?.close();
  });

  it("preserves initialization instructions, six tools, schemas, annotations, results, errors, and cancellation", async () => {
    const token = createApiKeyToken().token;
    const bridgeController = new AbortController();
    const fetchSignals: (AbortSignal | null | undefined)[] = [];
    let holdNextFetch = false;
    let heldFetchStarted: (() => void) | undefined;
    let releaseHeldFetch: (() => void) | undefined;
    const heldFetchStart = new Promise<void>((resolve) => {
      heldFetchStarted = resolve;
    });
    const heldFetchRelease = new Promise<void>((resolve) => {
      releaseHeldFetch = resolve;
    });
    const { app } = createTestApplication({
      memoryStore: new FakeRepositoryMemoryStore(),
      authenticator: {
        authenticate: (candidate) =>
          Promise.resolve(
            candidate === token
              ? {
                  accountId: "00000000-0000-4000-8000-000000000001",
                  apiKeyId: "00000000-0000-4000-8000-000000000002",
                }
              : undefined,
          ),
      },
    });
    const appFetch: typeof fetch = async (input, init) => {
      fetchSignals.push(init?.signal);
      if (holdNextFetch) {
        holdNextFetch = false;
        heldFetchStarted?.();
        await heldFetchRelease;
      }
      const source = new Request(input, init);
      const headers = new Headers(source.headers);
      headers.set("host", "localhost");
      return app.fetch(new Request(source, { headers }));
    };
    upstream = await connectUpstream({
      endpoint: new URL("http://localhost/mcp"),
      token,
      fetch: appFetch,
      deadlineMilliseconds: 3_000,
      signal: bridgeController.signal,
    });
    expect(upstream.instructions).toBe(ACTIVATION_INSTRUCTIONS);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const controller = new AbortController();
    const proxy = createStdioProxyServer(upstream, controller.signal);
    await proxy.connect(serverTransport);
    client = new Client({ name: "bridge-contract", version: "1.0.0" });
    await client.connect(clientTransport);
    expect(client.getInstructions()).toBe(ACTIVATION_INSTRUCTIONS);
    const direct = await upstream.client.listTools();
    const requestControllerForFetch = new AbortController();
    holdNextFetch = true;
    const pendingFetch = upstream.client.listTools(undefined, {
      signal: requestControllerForFetch.signal,
      cacheMode: "bypass",
    });
    await heldFetchStart;
    const requestFetchSignal = fetchSignals.at(-1);
    expect(requestFetchSignal).toBeDefined();
    requestControllerForFetch.abort();
    const requestCancellationReachedFetch = requestFetchSignal?.aborted;
    expect(bridgeController.signal.aborted).toBe(false);
    releaseHeldFetch?.();
    await pendingFetch.catch(() => undefined);
    expect(requestCancellationReachedFetch).toBe(true);
    const bridged = await client.listTools();
    expect(bridged).toEqual(direct);
    expect(bridged.tools).toHaveLength(6);
    expect(
      bridged.tools.every(({ outputSchema }) => outputSchema !== undefined),
    ).toBe(true);
    const result = await client.callTool({
      name: "search_skills",
      arguments: { task: "TypeScript review", limit: 1 },
    });
    expect(result.isError).not.toBe(true);
    const invalid = await client.callTool({
      name: "search_skills",
      arguments: { task: "x", extra: true },
    });
    expect(invalid.isError).toBe(true);

    const upstreamCall = vi.spyOn(upstream.client, "callTool");
    await expect(
      client.callTool({ name: "not_a_skillwire_tool", arguments: {} }),
    ).rejects.toThrow();
    expect(upstreamCall).not.toHaveBeenCalled();

    let forwardedSignal: AbortSignal | undefined;
    upstreamCall.mockImplementationOnce((_request, options) => {
      forwardedSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        forwardedSignal?.addEventListener(
          "abort",
          () => {
            reject(new Error("forwarded request cancelled"));
          },
          { once: true },
        );
      });
    });
    const requestController = new AbortController();
    const pending = client.callTool(
      { name: "search_skills", arguments: { task: "cancellation" } },
      { signal: requestController.signal },
    );
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(forwardedSignal).toBeDefined();
    });
    requestController.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await vi.waitFor(() => {
      expect(forwardedSignal?.aborted).toBe(true);
    });

    controller.abort();
    await expect(client.listTools()).rejects.toThrow();
  });
});
