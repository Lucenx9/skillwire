import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestApplication } from "../../../src/composition.js";
import { searchSkillsOutputSchema } from "../../../src/transport/mcp/schemas.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../../helpers/mcp-client.js";

describe("search_skills MCP contract", () => {
  let testClient: TestMcpClient | undefined;
  let responseSessionIds: (string | null)[];

  const client = (): TestMcpClient => {
    if (testClient === undefined)
      throw new Error("Test client is not connected");
    return testClient;
  };

  beforeEach(async () => {
    const { app } = createTestApplication();
    responseSessionIds = [];
    const appFetch: typeof fetch = async (input, init) => {
      const source = new Request(input, init);
      const headers = new Headers(source.headers);
      headers.set("host", "localhost");
      const request = new Request(source, { headers });
      const response = await app.fetch(request);
      responseSessionIds.push(response.headers.get("mcp-session-id"));
      return response;
    };
    testClient = await createTestMcpClient(
      new URL("http://localhost/mcp"),
      appFetch,
    );
  });

  afterEach(async () => {
    await testClient?.close();
  });

  it("exposes only search_skills", async () => {
    const { tools } = await client().client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["search_skills"]);
    expect(responseSessionIds.every((sessionId) => sessionId === null)).toBe(
      true,
    );
  });

  it("returns deterministic preview-only results", async () => {
    const request = {
      name: "search_skills",
      arguments: {
        task: "Review strict TypeScript changes and unsafe type narrowing",
        limit: 3,
      },
    };

    const first = await client().client.callTool(request);
    const second = await client().client.callTool(request);
    const firstOutput = searchSkillsOutputSchema.parse(first.structuredContent);
    const secondOutput = searchSkillsOutputSchema.parse(
      second.structuredContent,
    );

    expect(firstOutput).toEqual(secondOutput);
    expect(firstOutput.skills).toHaveLength(3);
    expect(firstOutput.skills[0]?.skillId).toBe("typescript-code-review");
    expect(firstOutput.skills[0]).toMatchObject({
      rank: 1,
      revision: "1.0.0",
      trustAtPublication: "trusted",
      currentAdvisoryStatus: "available",
    });

    const serialized = JSON.stringify(firstOutput);
    expect(serialized).not.toMatch(
      /instructions|resourceManifest|resourceBodies|contentBody|sourcePath/i,
    );
  });

  it("makes all ten curated metadata entries discoverable", async () => {
    const result = await client().client.callTool({
      name: "search_skills",
      arguments: { task: "engineering", limit: 10 },
    });
    const output = searchSkillsOutputSchema.parse(result.structuredContent);

    expect(output.skills).toHaveLength(10);
    expect(new Set(output.skills.map((skill) => skill.skillId)).size).toBe(10);
  });

  it("rejects unknown input properties", async () => {
    const result = await client().client.callTool({
      name: "search_skills",
      arguments: { task: "TypeScript review", extra: true },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});
