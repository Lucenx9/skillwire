import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { createTestApplication } from "../../../src/composition.js";
import { loadSkillOutputSchema } from "../../../src/transport/mcp/schemas.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../../helpers/mcp-client.js";
import { createPublishedCatalogWithStatus } from "../../helpers/catalog-cli.js";
import { searchSkillsOutputSchema } from "../../../src/transport/mcp/schemas.js";

describe("load_skill MCP contract", () => {
  let testClient: TestMcpClient | undefined;
  const workspaces: string[] = [];

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
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true });
    }
  });

  async function reconnect(projectRoot: string): Promise<void> {
    await testClient?.close();
    const { app } = createTestApplication({}, projectRoot);
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
  }

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

  it("returns immutable trust and derived unavailable status from verified cache", async () => {
    const workspace = createPublishedCatalogWithStatus("unavailable");
    workspaces.push(workspace);
    await reconnect(workspace);

    const search = await client().client.callTool({
      name: "search_skills",
      arguments: { task: "TypeScript code review", limit: 10 },
    });
    const preview = searchSkillsOutputSchema
      .parse(search.structuredContent)
      .skills.find((skill) => skill.skillId === "typescript-code-review");
    expect(preview).toMatchObject({
      trustAtPublication: "trusted",
      currentAdvisoryStatus: "unavailable",
    });

    const loaded = await client().client.callTool({
      name: "load_skill",
      arguments: { skillId: "typescript-code-review", revision: "1.0.0" },
    });
    expect(loadSkillOutputSchema.parse(loaded.structuredContent)).toMatchObject(
      {
        publishedProvenance: { trustAtPublication: "trusted" },
        currentAdvisoryStatus: "unavailable",
      },
    );
  });

  it("omits revoked revisions from search and rejects exact loads without disclosure", async () => {
    const workspace = createPublishedCatalogWithStatus("revoked");
    workspaces.push(workspace);
    await reconnect(workspace);

    const search = await client().client.callTool({
      name: "search_skills",
      arguments: { task: "TypeScript code review", limit: 10 },
    });
    expect(
      searchSkillsOutputSchema
        .parse(search.structuredContent)
        .skills.some((skill) => skill.skillId === "typescript-code-review"),
    ).toBe(false);

    const loaded = await client().client.callTool({
      name: "load_skill",
      arguments: { skillId: "typescript-code-review", revision: "1.0.0" },
    });
    expect(loaded.isError).toBe(true);
    const text = loaded.content.find((entry) => entry.type === "text");
    if (text?.type !== "text") throw new Error("Expected safe tool error");
    expect(JSON.parse(text.text)).toMatchObject({
      error: { code: "NOT_FOUND", retryable: false },
    });
  });
});
