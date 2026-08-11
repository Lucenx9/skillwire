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
      description:
        "Load one exact immutable skill revision and its resource manifest.",
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
      description:
        "Read one declared verified textual resource from an exact revision.",
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
      description: "Return deterministic ranked metadata previews for a task.",
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
      description:
        "List exact skill revisions used in one account-scoped repository.",
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
      description: "Replace the outcome for one previously loaded revision.",
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
      description:
        "Transactionally forget one account-scoped repository memory namespace.",
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
