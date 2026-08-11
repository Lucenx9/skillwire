import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

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
} from "../../../src/transport/mcp/schemas.js";

const contracts = [
  ["search_skills.input.schema.json", searchSkillsInputSchema],
  ["search_skills.output.schema.json", searchSkillsOutputSchema],
  ["load_skill.input.schema.json", loadSkillInputSchema],
  ["load_skill.output.schema.json", loadSkillOutputSchema],
  ["read_skill_resource.input.schema.json", readSkillResourceInputSchema],
  ["read_skill_resource.output.schema.json", readSkillResourceOutputSchema],
  ["list_repo_memory.input.schema.json", listRepoMemoryInputSchema],
  ["list_repo_memory.output.schema.json", listRepoMemoryOutputSchema],
  ["record_skill_outcome.input.schema.json", recordSkillOutcomeInputSchema],
  ["record_skill_outcome.output.schema.json", recordSkillOutcomeOutputSchema],
  ["forget_repo_memory.input.schema.json", forgetRepoMemoryInputSchema],
  ["forget_repo_memory.output.schema.json", forgetRepoMemoryOutputSchema],
] as const;

interface ObjectJsonSchema {
  readonly type?: unknown;
  readonly additionalProperties?: unknown;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
}

describe("MCP JSON schema drift", () => {
  it.each(contracts)(
    "keeps strict top-level shape aligned for %s",
    (fileName, executableSchema) => {
      const generated = z.toJSONSchema(executableSchema) as ObjectJsonSchema;
      const committed = JSON.parse(
        readFileSync(
          join(
            process.cwd(),
            "specs/001-remote-skill-delivery/contracts/schemas",
            fileName,
          ),
          "utf8",
        ),
      ) as ObjectJsonSchema;

      expect(generated.type).toBe("object");
      expect(generated.additionalProperties).toBe(false);
      expect(committed.type).toBe("object");
      expect(committed.additionalProperties).toBe(false);
      expect(Object.keys(generated.properties ?? {}).toSorted()).toEqual(
        Object.keys(committed.properties ?? {}).toSorted(),
      );
      expect([...(generated.required ?? [])].toSorted()).toEqual(
        [...(committed.required ?? [])].toSorted(),
      );
    },
  );
});
