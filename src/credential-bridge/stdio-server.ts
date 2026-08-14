/* eslint-disable @typescript-eslint/no-deprecated -- A transparent protocol proxy needs the advanced low-level Server API. */
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import {
  SKILLWIRE_TOOL_NAMES,
  type UpstreamConnection,
} from "./upstream-client.js";
import { bridgeMcpError } from "./bridge-errors.js";

const allowedTools = new Set<string>(SKILLWIRE_TOOL_NAMES);

function requestSignal(
  bridgeSignal: AbortSignal,
  requestSignal: AbortSignal,
): AbortSignal {
  return AbortSignal.any([bridgeSignal, requestSignal]);
}

export function createStdioProxyServer(
  upstream: UpstreamConnection,
  signal: AbortSignal,
): Server {
  const server = new Server(
    { name: "skillwire", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: upstream.instructions },
  );
  server.setRequestHandler("tools/list", async (request, context) => {
    try {
      return await upstream.client.listTools(request.params, {
        signal: requestSignal(signal, context.mcpReq.signal),
        timeout: 5_000,
        maxTotalTimeout: 5_000,
        cacheMode: "bypass",
      });
    } catch (error) {
      throw bridgeMcpError(
        error,
        context.mcpReq.signal.aborted || signal.aborted
          ? "cancellation"
          : "transport",
      );
    }
  });
  server.setRequestHandler("tools/call", async (request, context) => {
    if (!allowedTools.has(request.params.name))
      throw new Error("Tool is not available through the SkillWire bridge");
    let result;
    try {
      result = await upstream.client.callTool(request.params, {
        signal: requestSignal(signal, context.mcpReq.signal),
        timeout: 5_000,
        maxTotalTimeout: 5_000,
      });
    } catch (error) {
      throw bridgeMcpError(
        error,
        context.mcpReq.signal.aborted || signal.aborted
          ? "cancellation"
          : "transport",
      );
    }
    const outputSchema = upstream.tools.find(
      ({ name }) => name === request.params.name,
    )?.outputSchema;
    return server.projectCallToolResult(result, outputSchema);
  });
  return server;
}

export async function serveStdioProxy(
  upstream: UpstreamConnection,
  signal: AbortSignal,
  ready: () => void,
): Promise<void> {
  const server = createStdioProxyServer(upstream, signal);
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 2 * 1024 * 1024,
  });
  await server.connect(transport);
  ready();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      process.stdin.removeListener("end", finish);
      signal.removeEventListener("abort", cancel);
    };
    const finish = (): void => {
      cleanup();
      resolve();
    };
    const cancel = (): void => {
      cleanup();
      reject(new Error("Credential bridge cancelled"));
    };
    process.stdin.once("end", finish);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  }).finally(async () => {
    await server.close();
  });
}
