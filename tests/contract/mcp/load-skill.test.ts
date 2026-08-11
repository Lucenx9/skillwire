import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestApplication } from "../../../src/composition.js";
import { loadSkillOutputSchema } from "../../../src/transport/mcp/schemas.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../../helpers/mcp-client.js";

describe("load_skill MCP contract", () => {
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

  it("returns one exact immutable revision without resource bodies", async () => {
    const request = {
      name: "load_skill",
      arguments: { skillId: "typescript-code-review", revision: "1.0.0" },
    };

    const first = await client().client.callTool(request);
    const second = await client().client.callTool(request);
    const output = loadSkillOutputSchema.parse(first.structuredContent);

    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(output).toMatchObject({
      skillId: "typescript-code-review",
      revision: "1.0.0",
      currentAdvisoryStatus: "available",
      memoryRecorded: false,
      publishedProvenance: {
        sourceRevision: "1.0.0",
        owner: "SkillWire maintainers",
        license: "Apache-2.0",
        trustAtPublication: "trusted",
      },
    });
    expect(output.revisionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(output.instructions).toContain("# TypeScript Code Review");
    expect(output.resourceManifest).toHaveLength(1);
    expect(output.resourceManifest[0]).toMatchObject({
      path: "references/review-checklist.md",
      mediaType: "text/markdown",
    });
    expect(JSON.stringify(output.resourceManifest)).not.toContain(
      "checklist\n",
    );
  });

  it("rejects unknown and floating revisions without substitution", async () => {
    for (const revision of ["2.0.0", "latest"]) {
      const result = await client().client.callTool({
        name: "load_skill",
        arguments: { skillId: "typescript-code-review", revision },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    }
  });
});
