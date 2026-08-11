import type { McpServer } from "@modelcontextprotocol/server";

import type { SearchSkills } from "../../application/use-cases/search-skills.js";
import {
  searchSkillsInputSchema,
  searchSkillsOutputSchema,
} from "./schemas.js";

export function registerSearchSkillsTool(
  server: McpServer,
  searchSkills: SearchSkills,
): void {
  server.registerTool(
    "search_skills",
    {
      title: "Search skills",
      description: "Return deterministic ranked metadata previews for a task.",
      inputSchema: searchSkillsInputSchema,
      outputSchema: searchSkillsOutputSchema,
    },
    (input) => {
      const output = searchSkillsOutputSchema.parse(
        searchSkills.execute(input),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
