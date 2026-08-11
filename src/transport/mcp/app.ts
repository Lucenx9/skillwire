import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Hono } from "hono";

import type { ApiKeyAuthenticator } from "../../authentication/api-key-authenticator.js";
import {
  bearerAuthentication,
  type SkillWireHonoEnvironment,
} from "../../authentication/middleware.js";
import type { ReadinessState } from "../../lifecycle/readiness-state.js";
import { createMcpServer, type McpUseCases } from "./server-factory.js";

export interface CreateAppOptions {
  readonly host: string;
  readonly authenticator: ApiKeyAuthenticator;
  readonly readiness: ReadinessState;
  readonly useCases: McpUseCases;
}

export function createApp(options: CreateAppOptions) {
  const app = createMcpHonoApp({
    host: options.host,
  }) as unknown as Hono<SkillWireHonoEnvironment>;

  app.get("/health/live", (context) => context.json({ status: "ok" }));
  app.get("/health/ready", (context) =>
    options.readiness.isReady()
      ? context.json({ status: "ready" })
      : context.json({ status: "not-ready" }, 503),
  );
  app.use("/mcp", bearerAuthentication(options.authenticator));
  app.post("/mcp", (context) => {
    const principal = context.get("principal");
    const handler = createMcpHandler(
      () => createMcpServer(options.useCases, principal),
      { legacy: "stateless" },
    );
    const variables = context.var as { parsedBody?: unknown };
    return handler.fetch(context.req.raw, { parsedBody: variables.parsedBody });
  });
  app.all("/mcp", (context) => context.text("Method not allowed.", 405));

  return app;
}
