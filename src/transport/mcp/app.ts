import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";

import type { SearchSkills } from "../../application/use-cases/search-skills.js";
import { bearerAuthentication } from "../../authentication/middleware.js";
import { createMcpServer } from "./server-factory.js";

export interface CreateAppOptions {
  readonly host: string;
  readonly bearerToken: string;
  readonly searchSkills: SearchSkills;
}

export function createApp(options: CreateAppOptions) {
  const app = createMcpHonoApp({ host: options.host });
  const handler = createMcpHandler(
    () => createMcpServer(options.searchSkills),
    {
      legacy: "stateless",
    },
  );

  app.get("/health/live", (context) => context.json({ status: "ok" }));
  app.get("/health/ready", (context) => context.json({ status: "ready" }));
  app.use("/mcp", bearerAuthentication(options.bearerToken));
  app.post("/mcp", (context) => {
    const variables = context.var as { parsedBody?: unknown };
    return handler.fetch(context.req.raw, { parsedBody: variables.parsedBody });
  });
  app.all("/mcp", (context) => context.text("Method not allowed.", 405));

  return app;
}
