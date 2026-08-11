import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestApplication } from "../../../src/composition.js";
import {
  listRepoMemoryOutputSchema,
  loadSkillOutputSchema,
} from "../../../src/transport/mcp/schemas.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../../helpers/mcp-client.js";
import { FakeRepositoryMemoryStore } from "../../helpers/memory-store.js";

const repositoryHash = "a".repeat(64);

describe("list_repo_memory MCP contract", () => {
  let testClient: TestMcpClient;

  beforeEach(async () => {
    const { app } = createTestApplication({
      memoryStore: new FakeRepositoryMemoryStore(),
    });
    testClient = await createTestMcpClient(
      new URL("http://localhost/mcp"),
      async (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set("host", "localhost");
        return app.fetch(new Request(request, { headers }));
      },
    );
  });

  afterEach(async () => testClient.close());

  it("automatically records a load only when repository context is present", async () => {
    const withMemory = loadSkillOutputSchema.parse(
      (
        await testClient.client.callTool({
          name: "load_skill",
          arguments: {
            skillId: "typescript-code-review",
            revision: "1.0.0",
            repositoryHash,
          },
        })
      ).structuredContent,
    );
    expect(withMemory.memoryRecorded).toBe(true);

    const listed = listRepoMemoryOutputSchema.parse(
      (
        await testClient.client.callTool({
          name: "list_repo_memory",
          arguments: { repositoryHash },
        })
      ).structuredContent,
    );
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({
      skillId: "typescript-code-review",
      revision: "1.0.0",
      usageCount: 1,
    });

    const withoutMemory = loadSkillOutputSchema.parse(
      (
        await testClient.client.callTool({
          name: "load_skill",
          arguments: { skillId: "node-api-design", revision: "1.0.0" },
        })
      ).structuredContent,
    );
    expect(withoutMemory.memoryRecorded).toBe(false);
    expect(
      listRepoMemoryOutputSchema.parse(
        (
          await testClient.client.callTool({
            name: "list_repo_memory",
            arguments: { repositoryHash },
          })
        ).structuredContent,
      ).entries,
    ).toHaveLength(1);
  });

  it("rejects malformed and unknown input fields", async () => {
    for (const arguments_ of [
      { repositoryHash: "A".repeat(64) },
      { repositoryHash, accountId: "caller-selected" },
    ]) {
      expect(
        (
          await testClient.client.callTool({
            name: "list_repo_memory",
            arguments: arguments_,
          })
        ).isError,
      ).toBe(true);
    }
  });
});
