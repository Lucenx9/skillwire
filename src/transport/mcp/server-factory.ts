import { McpServer } from "@modelcontextprotocol/server";

import type { LoadSkill } from "../../application/use-cases/load-skill.js";
import type { ReadSkillResource } from "../../application/use-cases/read-skill-resource.js";
import type { SearchSkills } from "../../application/use-cases/search-skills.js";
import {
  registerLoadSkillTool,
  registerReadSkillResourceTool,
  registerSearchSkillsTool,
} from "./tool-adapters.js";

export interface McpUseCases {
  readonly searchSkills: SearchSkills;
  readonly loadSkill: LoadSkill;
  readonly readSkillResource: ReadSkillResource;
}

export function createMcpServer(useCases: McpUseCases): McpServer {
  const server = new McpServer({ name: "skillwire", version: "0.1.0" });
  registerLoadSkillTool(server, useCases.loadSkill);
  registerReadSkillResourceTool(server, useCases.readSkillResource);
  registerSearchSkillsTool(server, useCases.searchSkills);
  return server;
}
