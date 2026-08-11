import { McpServer } from "@modelcontextprotocol/server";

import type { SearchSkills } from "../../application/use-cases/search-skills.js";
import { registerSearchSkillsTool } from "./tool-adapters.js";

export function createMcpServer(searchSkills: SearchSkills): McpServer {
  const server = new McpServer({ name: "skillwire", version: "0.1.0" });
  registerSearchSkillsTool(server, searchSkills);
  return server;
}
