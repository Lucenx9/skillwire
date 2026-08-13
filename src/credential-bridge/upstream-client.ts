import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/client";

import { parseApiKeyToken } from "../authentication/api-key-token.js";
import { BridgeFailure } from "./bridge-errors.js";

export const SKILLWIRE_TOOL_NAMES = [
  "search_skills",
  "load_skill",
  "read_skill_resource",
  "list_repo_memory",
  "record_skill_outcome",
  "forget_repo_memory",
] as const;

function validateEndpoint(endpoint: URL): void {
  if (endpoint.protocol !== "http:")
    throw new BridgeFailure("BRIDGE_ENDPOINT_INVALID");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
    throw new BridgeFailure("BRIDGE_ENDPOINT_INVALID");
  if (
    endpoint.pathname !== "/mcp" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new BridgeFailure("BRIDGE_ENDPOINT_INVALID");
  }
}

function validateTools(result: ListToolsResult): void {
  const names = result.tools.map(({ name }) => name);
  if (JSON.stringify(names) !== JSON.stringify(SKILLWIRE_TOOL_NAMES))
    throw new BridgeFailure("BRIDGE_CONTRACT_INVALID");
  for (const tool of result.tools) {
    if (
      tool.outputSchema === undefined ||
      tool.annotations === undefined ||
      tool.description === undefined
    ) {
      throw new BridgeFailure("BRIDGE_CONTRACT_INVALID");
    }
  }
}

export interface UpstreamConnection {
  readonly client: Client;
  readonly instructions: string;
  readonly tools: readonly Tool[];
  close(): Promise<void>;
}

export interface ConnectUpstreamOptions {
  readonly endpoint: URL;
  readonly token: string;
  readonly fetch?: FetchLike | undefined;
  readonly deadlineMilliseconds: number;
  readonly signal?: AbortSignal | undefined;
}

export async function connectUpstream(
  options: ConnectUpstreamOptions,
): Promise<UpstreamConnection> {
  validateEndpoint(options.endpoint);
  if (parseApiKeyToken(options.token) === undefined)
    throw new BridgeFailure("BRIDGE_CREDENTIAL_UNAVAILABLE");
  if (options.deadlineMilliseconds < 1 || options.deadlineMilliseconds > 10_000)
    throw new Error("Bridge deadline is invalid");
  const sourceFetch = options.fetch ?? fetch;
  const startedAt = performance.now();
  const deadlineSignal = AbortSignal.timeout(options.deadlineMilliseconds);
  let initializing = true;
  const budget = (): number => {
    const remaining = Math.floor(
      options.deadlineMilliseconds - (performance.now() - startedAt),
    );
    if (remaining < 1) throw new BridgeFailure("BRIDGE_DEADLINE_EXCEEDED");
    return remaining;
  };
  let requestCount = 0;
  const boundedFetch: FetchLike = async (input, init) => {
    requestCount += 1;
    const target = new URL(input.toString());
    if (
      target.origin !== options.endpoint.origin ||
      target.pathname !== options.endpoint.pathname
    )
      throw new Error("Bridge refused a non-upstream HTTP request");
    const signals = [
      options.signal,
      ...(initializing ? [deadlineSignal] : []),
      init?.signal,
      input instanceof Request ? input.signal : undefined,
    ].filter(
      (signal): signal is AbortSignal =>
        signal !== undefined && signal !== null,
    );
    const signal =
      signals.length > 1
        ? AbortSignal.any(signals)
        : signals.length === 1
          ? signals[0]
          : undefined;
    const response = await sourceFetch(input, {
      ...init,
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      response.ok &&
      response.headers.get("content-type")?.includes("application/json") ===
        true
    ) {
      try {
        await response.clone().json();
      } catch (error) {
        throw new BridgeFailure("BRIDGE_CONTRACT_INVALID", { cause: error });
      }
    }
    return response;
  };
  const client = new Client(
    { name: "skillwire-credential-bridge", version: "0.1.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(options.endpoint, {
    authProvider: { token: () => Promise.resolve(options.token) },
    fetch: boundedFetch,
    onInsufficientScope: "throw",
    maxStepUpRetries: 0,
  });
  try {
    await client.connect(transport, {
      timeout: budget(),
      maxTotalTimeout: budget(),
      signal:
        options.signal === undefined
          ? deadlineSignal
          : AbortSignal.any([options.signal, deadlineSignal]),
    });
    const listed = await client.listTools(undefined, {
      timeout: budget(),
      maxTotalTimeout: budget(),
      signal:
        options.signal === undefined
          ? deadlineSignal
          : AbortSignal.any([options.signal, deadlineSignal]),
      cacheMode: "bypass",
    });
    validateTools(listed);
    const instructions = client.getInstructions();
    if (
      instructions === undefined ||
      instructions.length < 1 ||
      instructions.length > 8192
    )
      throw new BridgeFailure("BRIDGE_CONTRACT_INVALID");
    if (requestCount < 2) throw new BridgeFailure("BRIDGE_CONTRACT_INVALID");
    initializing = false;
    return {
      client,
      instructions,
      tools: listed.tools,
      close: () => client.close(),
    };
  } catch (error) {
    initializing = false;
    await client.close().catch(() => undefined);
    if (error instanceof BridgeFailure) throw error;
    if (options.signal?.aborted === true)
      throw new BridgeFailure("BRIDGE_CANCELLED", { cause: error });
    if (deadlineSignal.aborted)
      throw new BridgeFailure("BRIDGE_DEADLINE_EXCEEDED", { cause: error });
    if (
      error instanceof Error &&
      /(?:timeout|timed out|aborterror|aborted)/i.test(
        `${error.name} ${error.message}`,
      )
    ) {
      throw new BridgeFailure("BRIDGE_DEADLINE_EXCEEDED", { cause: error });
    }
    if (
      error instanceof Error &&
      /(?:401|403|unauthori[sz]ed|authentication|insufficient scope)/i.test(
        error.message,
      )
    ) {
      throw new BridgeFailure("BRIDGE_AUTH_REJECTED", { cause: error });
    }
    if (
      error instanceof Error &&
      /(?:protocol|contract|tool metadata|six-tool|instructions|invalid.*(?:json|response)|parse)/i.test(
        error.message,
      )
    ) {
      throw new BridgeFailure("BRIDGE_CONTRACT_INVALID", { cause: error });
    }
    throw new BridgeFailure("BRIDGE_TRANSPORT_UNAVAILABLE", { cause: error });
  }
}
