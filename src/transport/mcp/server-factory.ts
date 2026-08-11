import { McpServer } from "@modelcontextprotocol/server";

import type { ForgetRepoMemory } from "../../application/use-cases/forget-repo-memory.js";
import type { ListRepoMemory } from "../../application/use-cases/list-repo-memory.js";
import type { LoadSkill } from "../../application/use-cases/load-skill.js";
import type { ReadSkillResource } from "../../application/use-cases/read-skill-resource.js";
import type { RecordSkillOutcome } from "../../application/use-cases/record-skill-outcome.js";
import type { SearchSkills } from "../../application/use-cases/search-skills.js";
import type { RequestPrincipal } from "../../domain/repository-memory/types.js";
import type { SecurityLogger } from "../../observability/logger.js";
import {
  registerForgetRepoMemoryTool,
  registerListRepoMemoryTool,
  registerLoadSkillTool,
  registerReadSkillResourceTool,
  registerRecordSkillOutcomeTool,
  registerSearchSkillsTool,
} from "./tool-adapters.js";

export interface McpUseCases {
  readonly searchSkills: SearchSkills;
  readonly loadSkill: LoadSkill;
  readonly readSkillResource: ReadSkillResource;
  readonly listRepoMemory: ListRepoMemory;
  readonly recordSkillOutcome: RecordSkillOutcome;
  readonly forgetRepoMemory: ForgetRepoMemory;
}

export function createMcpServer(
  useCases: McpUseCases,
  principal: RequestPrincipal,
  logger: SecurityLogger,
): McpServer {
  const server = new McpServer({ name: "skillwire", version: "0.1.0" });
  registerSearchSkillsTool(server, useCases.searchSkills, principal, logger);
  registerLoadSkillTool(server, useCases.loadSkill, principal, logger);
  registerReadSkillResourceTool(
    server,
    useCases.readSkillResource,
    principal,
    logger,
  );
  registerListRepoMemoryTool(
    server,
    useCases.listRepoMemory,
    principal,
    logger,
  );
  registerRecordSkillOutcomeTool(
    server,
    useCases.recordSkillOutcome,
    principal,
    logger,
  );
  registerForgetRepoMemoryTool(
    server,
    useCases.forgetRepoMemory,
    principal,
    logger,
  );
  return server;
}
