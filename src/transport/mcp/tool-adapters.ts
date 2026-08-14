import type { McpServer } from "@modelcontextprotocol/server";

import type { LoadSkill } from "../../application/use-cases/load-skill.js";
import type { ForgetRepoMemory } from "../../application/use-cases/forget-repo-memory.js";
import type { ListRepoMemory } from "../../application/use-cases/list-repo-memory.js";
import type { ReadSkillResource } from "../../application/use-cases/read-skill-resource.js";
import type { RecordSkillOutcome } from "../../application/use-cases/record-skill-outcome.js";
import type { SearchSkills } from "../../application/use-cases/search-skills.js";
import type { RequestPrincipal } from "../../domain/repository-memory/types.js";
import { assertRequestActive } from "../../application/request-execution.js";
import {
  safeErrorEnvelope,
  safeSkillWireError,
} from "../../application/errors.js";
import type { SecurityLogger } from "../../observability/logger.js";
import { TOOL_METADATA } from "./activation-policy.js";
import {
  forgetRepoMemoryInputSchema,
  forgetRepoMemoryOutputSchema,
  listRepoMemoryInputSchema,
  listRepoMemoryOutputSchema,
  loadSkillInputSchema,
  loadSkillOutputSchema,
  readSkillResourceInputSchema,
  readSkillResourceOutputSchema,
  recordSkillOutcomeInputSchema,
  recordSkillOutcomeOutputSchema,
  searchSkillsInputSchema,
  searchSkillsOutputSchema,
} from "./schemas.js";

function toolFailure(
  error: unknown,
  principal: RequestPrincipal,
  logger: SecurityLogger,
  tool: string,
) {
  const safe = safeSkillWireError(error);
  logger.emit("tool_failed", {
    requestId: principal.requestId,
    accountId: principal.accountId,
    apiKeyId: principal.apiKeyId,
    code: safe.code,
    tool,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(safeErrorEnvelope(safe, principal.requestId)),
      },
    ],
    isError: true,
  };
}

export function registerLoadSkillTool(
  server: McpServer,
  loadSkill: LoadSkill,
  principal: RequestPrincipal,
  logger: SecurityLogger,
): void {
  server.registerTool(
    "load_skill",
    {
      title: "Load skill",
      ...TOOL_METADATA.load_skill,
      inputSchema: loadSkillInputSchema,
      outputSchema: loadSkillOutputSchema,
    },
    async (input) => {
      try {
        assertRequestActive(principal);
        const output = loadSkillOutputSchema.parse(
          await loadSkill.execute(input, principal),
        );
        assertRequestActive(principal);
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error, principal, logger, "load_skill");
      }
    },
  );
}

export function registerReadSkillResourceTool(
  server: McpServer,
  readSkillResource: ReadSkillResource,
  principal: RequestPrincipal,
  logger: SecurityLogger,
): void {
  server.registerTool(
    "read_skill_resource",
    {
      title: "Read skill resource",
      ...TOOL_METADATA.read_skill_resource,
      inputSchema: readSkillResourceInputSchema,
      outputSchema: readSkillResourceOutputSchema,
    },
    async (input) => {
      try {
        assertRequestActive(principal);
        const output = readSkillResourceOutputSchema.parse(
          await readSkillResource.execute(input, principal),
        );
        assertRequestActive(principal);
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error, principal, logger, "read_skill_resource");
      }
    },
  );
}

export function registerSearchSkillsTool(
  server: McpServer,
  searchSkills: SearchSkills,
  principal: RequestPrincipal,
  logger: SecurityLogger,
): void {
  server.registerTool(
    "search_skills",
    {
      title: "Search skills",
      ...TOOL_METADATA.search_skills,
      inputSchema: searchSkillsInputSchema,
      outputSchema: searchSkillsOutputSchema,
    },
    async (input) => {
      try {
        assertRequestActive(principal);
        const output = searchSkillsOutputSchema.parse(
          await searchSkills.execute(input, principal),
        );
        assertRequestActive(principal);
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error, principal, logger, "search_skills");
      }
    },
  );
}

export function registerListRepoMemoryTool(
  server: McpServer,
  listRepoMemory: ListRepoMemory,
  principal: RequestPrincipal,
  logger: SecurityLogger,
): void {
  server.registerTool(
    "list_repo_memory",
    {
      title: "List repository memory",
      ...TOOL_METADATA.list_repo_memory,
      inputSchema: listRepoMemoryInputSchema,
      outputSchema: listRepoMemoryOutputSchema,
    },
    async (input) => {
      try {
        assertRequestActive(principal);
        const output = listRepoMemoryOutputSchema.parse(
          await listRepoMemory.execute(input, principal),
        );
        assertRequestActive(principal);
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error, principal, logger, "list_repo_memory");
      }
    },
  );
}

export function registerRecordSkillOutcomeTool(
  server: McpServer,
  recordSkillOutcome: RecordSkillOutcome,
  principal: RequestPrincipal,
  logger: SecurityLogger,
): void {
  server.registerTool(
    "record_skill_outcome",
    {
      title: "Record skill outcome",
      ...TOOL_METADATA.record_skill_outcome,
      inputSchema: recordSkillOutcomeInputSchema,
      outputSchema: recordSkillOutcomeOutputSchema,
    },
    async (input) => {
      try {
        assertRequestActive(principal);
        const output = recordSkillOutcomeOutputSchema.parse(
          await recordSkillOutcome.execute(input, principal),
        );
        assertRequestActive(principal);
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error, principal, logger, "record_skill_outcome");
      }
    },
  );
}

export function registerForgetRepoMemoryTool(
  server: McpServer,
  forgetRepoMemory: ForgetRepoMemory,
  principal: RequestPrincipal,
  logger: SecurityLogger,
): void {
  server.registerTool(
    "forget_repo_memory",
    {
      title: "Forget repository memory",
      ...TOOL_METADATA.forget_repo_memory,
      inputSchema: forgetRepoMemoryInputSchema,
      outputSchema: forgetRepoMemoryOutputSchema,
    },
    async (input) => {
      try {
        assertRequestActive(principal);
        const output = forgetRepoMemoryOutputSchema.parse(
          await forgetRepoMemory.execute(input, principal),
        );
        assertRequestActive(principal);
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error, principal, logger, "forget_repo_memory");
      }
    },
  );
}
