import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import {
  createTestApplication,
  type TestApplicationOptions,
} from "../../src/composition.js";
import { snapshotTree } from "./filesystem-snapshot.js";
import { TEST_BEARER_TOKEN } from "./mcp-client.js";

export type ActivationProtocol = "legacy" | "modern";

export interface RecordedToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ActivationMcpHarness {
  readonly client: Client;
  readonly protocolMethods: readonly string[];
  readonly toolCalls: readonly RecordedToolCall[];
  readonly clientTree: string;
  readonly httpStatuses: readonly number[];
  readonly githubRequestCount: number;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
  ): ReturnType<Client["callTool"]>;
  clientTreeIsUnchanged(): Promise<boolean>;
  close(): Promise<void>;
}

export interface CreateActivationMcpHarnessOptions {
  readonly protocol: ActivationProtocol;
  readonly application?: TestApplicationOptions;
  readonly bearerToken?: string;
  readonly maxToolCalls?: number;
  readonly serviceUnavailable?: boolean;
}

export interface ActivationConnectionAttempt {
  readonly connected: boolean;
  readonly protocolMethods: readonly string[];
  readonly httpStatuses: readonly number[];
  readonly toolCalls: readonly RecordedToolCall[];
  readonly clientTreeUnchanged: boolean;
}

export async function createActivationMcpHarness(
  options: CreateActivationMcpHarnessOptions,
): Promise<ActivationMcpHarness> {
  const { app } = createTestApplication(options.application);
  const protocolMethods: string[] = [];
  const toolCalls: RecordedToolCall[] = [];
  const httpStatuses: number[] = [];
  let githubRequestCount = 0;
  const clientTree = await mkdtemp(join(tmpdir(), "skillwire-activation-"));
  const beforeTree = await snapshotTree(clientTree);

  const appFetch: typeof fetch = async (input, init) => {
    const source = new Request(input, init);
    if (source.url.includes("api.github.com")) githubRequestCount += 1;
    if (source.method === "POST") {
      const body = (await source.clone().json()) as {
        method?: unknown;
        params?: { name?: unknown; arguments?: unknown };
      };
      if (typeof body.method === "string") {
        protocolMethods.push(body.method);
      }
      if (
        body.method === "tools/call" &&
        typeof body.params?.name === "string"
      ) {
        toolCalls.push({
          name: body.params.name,
          arguments:
            body.params.arguments !== null &&
            typeof body.params.arguments === "object" &&
            !Array.isArray(body.params.arguments)
              ? { ...body.params.arguments }
              : {},
        });
      }
    }
    const response =
      options.serviceUnavailable === true
        ? new Response(
            JSON.stringify({
              error: {
                code: "INTERNAL",
                message: "The request could not be completed.",
                retryable: true,
                requestId: "00000000-0000-4000-8000-000000000000",
              },
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          )
        : await (() => {
            const headers = new Headers(source.headers);
            headers.set("host", "localhost");
            return app.fetch(new Request(source, { headers }));
          })();
    httpStatuses.push(response.status);
    return response;
  };

  const client = new Client(
    { name: "skillwire-activation-test", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: options.protocol === "modern" ? { pin: "2026-07-28" } : "legacy",
      },
    },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost/mcp"),
    {
      authProvider: {
        token: () => Promise.resolve(options.bearerToken ?? TEST_BEARER_TOKEN),
      },
      fetch: appFetch,
    },
  );

  try {
    await client.connect(transport);
  } catch (error) {
    await rm(clientTree, { recursive: true, force: true });
    if (error !== null && typeof error === "object") {
      Object.assign(error, {
        protocolMethods: [...protocolMethods],
        httpStatuses: [...httpStatuses],
      });
    }
    throw error;
  }

  let closed = false;
  return {
    client,
    protocolMethods,
    toolCalls,
    clientTree,
    httpStatuses,
    get githubRequestCount() {
      return githubRequestCount;
    },
    callTool: (name, arguments_) => {
      if (toolCalls.length >= (options.maxToolCalls ?? 7)) {
        throw new Error("Activation operation cap exceeded");
      }
      return client.callTool({ name, arguments: arguments_ });
    },
    clientTreeIsUnchanged: async () =>
      (await snapshotTree(clientTree)) === beforeTree,
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close();
      await rm(clientTree, { recursive: true, force: true });
    },
  };
}

export async function attemptActivationMcpConnection(
  options: CreateActivationMcpHarnessOptions,
): Promise<ActivationConnectionAttempt> {
  try {
    const harness = await createActivationMcpHarness(options);
    const result = {
      connected: true,
      protocolMethods: [...harness.protocolMethods],
      httpStatuses: [...harness.httpStatuses],
      toolCalls: [...harness.toolCalls],
      clientTreeUnchanged: await harness.clientTreeIsUnchanged(),
    };
    await harness.close();
    return result;
  } catch (error) {
    const details = error as {
      protocolMethods?: readonly string[];
      httpStatuses?: readonly number[];
    };
    return {
      connected: false,
      protocolMethods: details.protocolMethods ?? [],
      httpStatuses: details.httpStatuses ?? [],
      toolCalls: [],
      clientTreeUnchanged: true,
    };
  }
}
