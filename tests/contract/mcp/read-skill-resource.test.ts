import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestApplication } from "../../../src/composition.js";
import { readSkillResourceOutputSchema } from "../../../src/transport/mcp/schemas.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../../helpers/mcp-client.js";

describe("read_skill_resource MCP contract", () => {
  let testClient: TestMcpClient | undefined;

  const client = (): TestMcpClient => {
    if (testClient === undefined)
      throw new Error("Test client is not connected");
    return testClient;
  };

  beforeEach(async () => {
    const { app } = createTestApplication();
    const appFetch: typeof fetch = async (input, init) => {
      const source = new Request(input, init);
      const headers = new Headers(source.headers);
      headers.set("host", "localhost");
      return app.fetch(new Request(source, { headers }));
    };
    testClient = await createTestMcpClient(
      new URL("http://localhost/mcp"),
      appFetch,
    );
  });

  afterEach(async () => {
    await testClient?.close();
  });

  it("returns only one exact declared textual resource", async () => {
    const result = await client().client.callTool({
      name: "read_skill_resource",
      arguments: {
        skillId: "typescript-code-review",
        revision: "1.0.0",
        path: "references/review-checklist.md",
      },
    });
    const output = readSkillResourceOutputSchema.parse(
      result.structuredContent,
    );

    expect(output).toMatchObject({
      skillId: "typescript-code-review",
      revision: "1.0.0",
      path: "references/review-checklist.md",
      mediaType: "text/markdown",
    });
    expect(output.revisionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.byteLength(output.content)).toBe(output.byteLength);
    expect(output.content).toContain("# TypeScript review checklist");
  });

  it.each([
    "../SKILL.md",
    "references/../../SKILL.md",
    "/etc/passwd",
    "references\\review-checklist.md",
    "references/not-declared.md",
  ])("rejects unsafe or undeclared resource path %s", async (path) => {
    const result = await client().client.callTool({
      name: "read_skill_resource",
      arguments: { skillId: "typescript-code-review", revision: "1.0.0", path },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("rejects an unknown exact revision", async () => {
    const result = await client().client.callTool({
      name: "read_skill_resource",
      arguments: {
        skillId: "typescript-code-review",
        revision: "2.0.0",
        path: "references/review-checklist.md",
      },
    });

    expect(result.isError).toBe(true);
  });
});
