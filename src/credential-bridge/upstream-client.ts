import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/client";

import { parseApiKeyToken } from "../authentication/api-key-token.js";

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
    throw new Error("Bridge endpoint must use loopback HTTP");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
    throw new Error("Bridge endpoint must be loopback-only");
  if (
    endpoint.pathname !== "/mcp" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("Bridge endpoint identity is invalid");
  }
}

function validateTools(result: ListToolsResult): void {
  const names = result.tools.map(({ name }) => name);
  if (JSON.stringify(names) !== JSON.stringify(SKILLWIRE_TOOL_NAMES))
    throw new Error(
      "Upstream does not expose the exact six-tool SkillWire contract",
    );
  for (const tool of result.tools) {
    if (
      tool.outputSchema === undefined ||
      tool.annotations === undefined ||
      tool.description === undefined
    ) {
      throw new Error(`Upstream tool metadata is incomplete: ${tool.name}`);
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
    throw new Error("Bridge credential has an invalid shape");
  if (options.deadlineMilliseconds < 1 || options.deadlineMilliseconds > 10_000)
    throw new Error("Bridge deadline is invalid");
  const sourceFetch = options.fetch ?? fetch;
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
    return sourceFetch(input, {
      ...init,
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
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
      timeout: options.deadlineMilliseconds,
      maxTotalTimeout: options.deadlineMilliseconds,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const listed = await client.listTools(undefined, {
      timeout: options.deadlineMilliseconds,
      maxTotalTimeout: options.deadlineMilliseconds,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      cacheMode: "bypass",
    });
    validateTools(listed);
    const instructions = client.getInstructions();
    if (
      instructions === undefined ||
      instructions.length < 1 ||
      instructions.length > 8192
    )
      throw new Error("Upstream instructions are missing or invalid");
    if (requestCount < 2)
      throw new Error("Upstream initialization was not fully validated");
    return {
      client,
      instructions,
      tools: listed.tools,
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
