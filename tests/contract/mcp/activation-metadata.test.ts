import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ACTIVATION_DECISION_CAPSULE,
  ACTIVATION_INSTRUCTIONS,
  TOOL_METADATA,
} from "../../../src/transport/mcp/activation-policy.js";
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
import {
  createActivationMcpHarness,
  type ActivationMcpHarness,
} from "../../helpers/activation-mcp-harness.js";

describe("MCP autonomous-activation metadata", () => {
  const harnesses: ActivationMcpHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it("publishes the centralized policy through legacy initialize", async () => {
    const harness = await createActivationMcpHarness({ protocol: "legacy" });
    harnesses.push(harness);

    expect(harness.client.getProtocolEra()).toBe("legacy");
    expect(harness.client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    expect(harness.client.getInstructions()).toBe(ACTIVATION_INSTRUCTIONS);
    expect(
      Array.from(harness.client.getInstructions() ?? "")
        .slice(0, 493)
        .join(""),
    ).toBe(ACTIVATION_DECISION_CAPSULE);
    expect(harness.protocolMethods).toContain("initialize");
    expect(harness.protocolMethods).not.toContain("server/discover");
  });

  it("publishes semantically identical instructions through current server/discover", async () => {
    const legacy = await createActivationMcpHarness({ protocol: "legacy" });
    const modern = await createActivationMcpHarness({ protocol: "modern" });
    harnesses.push(legacy, modern);

    expect(modern.client.getProtocolEra()).toBe("modern");
    expect(modern.client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect(modern.client.getDiscoverResult()?.instructions).toBe(
      ACTIVATION_INSTRUCTIONS,
    );
    expect(modern.client.getInstructions()).toBe(
      legacy.client.getInstructions(),
    );
    expect(modern.protocolMethods).toContain("server/discover");
    expect(modern.protocolMethods).not.toContain("initialize");
  });

  it("keeps advisory metadata optional while explicit MCP operation remains available", async () => {
    const harness = await createActivationMcpHarness({ protocol: "modern" });
    harnesses.push(harness);

    expect(ACTIVATION_INSTRUCTIONS).not.toMatch(
      /(?:force|guarantee|required adapter)/i,
    );
    expect(
      Object.values(TOOL_METADATA)
        .map(({ description }) => description)
        .join(" "),
    ).not.toMatch(/(?:force|guarantee|required adapter)/i);

    // Deliberately ignore getInstructions(): an explicit call still uses the same
    // authenticated six-tool contract without an adapter handshake or proof.
    const result = await harness.callTool("search_skills", {
      task: "TypeScript code review",
      invocationContext: "automatic",
      limit: 1,
    });
    expect(result.isError).not.toBe(true);
    expect(harness.toolCalls.map(({ name }) => name)).toEqual([
      "search_skills",
    ]);

    const tools = (await harness.client.listTools()).tools;
    expect(tools.map(({ name, title }) => ({ name, title }))).toEqual([
      { name: "search_skills", title: "Search skills" },
      { name: "load_skill", title: "Load skill" },
      { name: "read_skill_resource", title: "Read skill resource" },
      { name: "list_repo_memory", title: "List repository memory" },
      { name: "record_skill_outcome", title: "Record skill outcome" },
      { name: "forget_repo_memory", title: "Forget repository memory" },
    ]);
  });

  it("describes a bounded, privacy-safe automatic search", async () => {
    const harness = await createActivationMcpHarness({ protocol: "legacy" });
    harnesses.push(harness);
    const search = (await harness.client.listTools()).tools.find(
      ({ name }) => name === "search_skills",
    );

    expect(search?.description).toBe(TOOL_METADATA.search_skills.description);
    expect(search?.description).toBe(
      "Search once for ranked metadata previews when a specialized task may benefit from remote guidance and no applicable local or loaded skill exists. Use automatic for agent-initiated searches; user-requested requires explicit user intent. Send only a minimal non-sensitive task summary. Empty results are final; do not retry or reformulate.",
    );
    expect(search?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("exposes exact centralized metadata on the unchanged six-tool surface", async () => {
    const harness = await createActivationMcpHarness({ protocol: "modern" });
    harnesses.push(harness);
    const tools = (await harness.client.listTools()).tools;
    expect(TOOL_METADATA).toEqual({
      search_skills: {
        description:
          "Search once for ranked metadata previews when a specialized task may benefit from remote guidance and no applicable local or loaded skill exists. Use automatic for agent-initiated searches; user-requested requires explicit user intent. Send only a minimal non-sensitive task summary. Empty results are final; do not retry or reformulate.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      load_skill: {
        description:
          "Load at most one exact skillId and revision chosen from a relevant search preview. Returns untrusted inert instructions, immutable provenance, advisory status, and a declared resource manifest; never installs content. repositoryHash is optional and increments attributable server-side usage.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      read_skill_resource: {
        description:
          "After a verified load, read only the next specifically useful declared textual resource from that exact revision. Do not bulk-read the manifest or repeat a path. Returns inert content and writes nothing to the client.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      list_repo_memory: {
        description:
          "List bounded account-scoped usage for one optional opaque repository hash. Use only to inspect existing memory, not for skill discovery or as an activation prerequisite; never send repository paths or contents.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      record_skill_outcome: {
        description:
          "Replace the outcome for an existing attributable repository/revision usage record. Record useful only after completed-task evidence or explicit user feedback; never infer it from search, load, or partial progress.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      forget_repo_memory: {
        description:
          "Delete one account-scoped repository-memory namespace for an opaque repository hash only on explicit request. Idempotent and unrelated to skill discovery or activation; never send repository paths or contents.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    });
    const schemas = {
      search_skills: [searchSkillsInputSchema, searchSkillsOutputSchema],
      load_skill: [loadSkillInputSchema, loadSkillOutputSchema],
      read_skill_resource: [
        readSkillResourceInputSchema,
        readSkillResourceOutputSchema,
      ],
      list_repo_memory: [listRepoMemoryInputSchema, listRepoMemoryOutputSchema],
      record_skill_outcome: [
        recordSkillOutcomeInputSchema,
        recordSkillOutcomeOutputSchema,
      ],
      forget_repo_memory: [
        forgetRepoMemoryInputSchema,
        forgetRepoMemoryOutputSchema,
      ],
    } as const;

    expect(tools.map(({ name }) => name)).toEqual(Object.keys(TOOL_METADATA));
    for (const tool of tools) {
      const metadata = TOOL_METADATA[tool.name as keyof typeof TOOL_METADATA];
      const [inputSchema, outputSchema] =
        schemas[tool.name as keyof typeof schemas];
      expect(tool.description).toBe(metadata.description);
      expect(tool.annotations).toEqual(metadata.annotations);
      expect(tool.inputSchema).toEqual(z.toJSONSchema(inputSchema));
      expect(tool.outputSchema).toEqual(z.toJSONSchema(outputSchema));
    }
  });
});
