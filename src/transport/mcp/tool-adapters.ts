import type { McpServer } from "@modelcontextprotocol/server";

import type { LoadSkill } from "../../application/use-cases/load-skill.js";
import type { ForgetRepoMemory } from "../../application/use-cases/forget-repo-memory.js";
import type { ListRepoMemory } from "../../application/use-cases/list-repo-memory.js";
import type { ReadSkillResource } from "../../application/use-cases/read-skill-resource.js";
import type { RecordSkillOutcome } from "../../application/use-cases/record-skill-outcome.js";
import type { SearchSkills } from "../../application/use-cases/search-skills.js";
import type { RequestPrincipal } from "../../domain/repository-memory/types.js";
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

export function registerLoadSkillTool(
  server: McpServer,
  loadSkill: LoadSkill,
  principal: RequestPrincipal,
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
      const output = loadSkillOutputSchema.parse(
        await loadSkill.execute(input, principal),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

export function registerReadSkillResourceTool(
  server: McpServer,
  readSkillResource: ReadSkillResource,
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
    (input) => {
      const output = readSkillResourceOutputSchema.parse(
        readSkillResource.execute(input),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

export function registerSearchSkillsTool(
  server: McpServer,
  searchSkills: SearchSkills,
  principal: RequestPrincipal,
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
      const output = searchSkillsOutputSchema.parse(
        await searchSkills.execute(input, principal),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

export function registerListRepoMemoryTool(
  server: McpServer,
  listRepoMemory: ListRepoMemory,
  principal: RequestPrincipal,
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
      const output = listRepoMemoryOutputSchema.parse(
        await listRepoMemory.execute(input, principal),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

export function registerRecordSkillOutcomeTool(
  server: McpServer,
  recordSkillOutcome: RecordSkillOutcome,
  principal: RequestPrincipal,
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
      const output = recordSkillOutcomeOutputSchema.parse(
        await recordSkillOutcome.execute(input, principal),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

export function registerForgetRepoMemoryTool(
  server: McpServer,
  forgetRepoMemory: ForgetRepoMemory,
  principal: RequestPrincipal,
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
      const output = forgetRepoMemoryOutputSchema.parse(
        await forgetRepoMemory.execute(input, principal),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
