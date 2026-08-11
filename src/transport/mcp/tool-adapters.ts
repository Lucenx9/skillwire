import type { McpServer } from "@modelcontextprotocol/server";

import type { LoadSkill } from "../../application/use-cases/load-skill.js";
import type { ReadSkillResource } from "../../application/use-cases/read-skill-resource.js";
import type { SearchSkills } from "../../application/use-cases/search-skills.js";
import {
  loadSkillInputSchema,
  loadSkillOutputSchema,
  readSkillResourceInputSchema,
  readSkillResourceOutputSchema,
  searchSkillsInputSchema,
  searchSkillsOutputSchema,
} from "./schemas.js";

export function registerLoadSkillTool(
  server: McpServer,
  loadSkill: LoadSkill,
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
    (input) => {
      const output = loadSkillOutputSchema.parse(loadSkill.execute(input));
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
