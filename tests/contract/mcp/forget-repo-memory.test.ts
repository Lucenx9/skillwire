import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestApplication } from "../../../src/composition.js";
import {
  forgetRepoMemoryOutputSchema,
  listRepoMemoryOutputSchema,
} from "../../../src/transport/mcp/schemas.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../../helpers/mcp-client.js";
import { FakeRepositoryMemoryStore } from "../../helpers/memory-store.js";

const repositoryHash = "c".repeat(64);

describe("forget_repo_memory MCP contract", () => {
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

  async function forget(hash: string) {
    return forgetRepoMemoryOutputSchema.parse(
      (
        await testClient.client.callTool({
          name: "forget_repo_memory",
          arguments: { repositoryHash: hash },
        })
      ).structuredContent,
    );
  }

  it("returns the same idempotent result for populated and empty scopes", async () => {
    await testClient.client.callTool({
      name: "load_skill",
      arguments: {
        skillId: "typescript-code-review",
        revision: "1.0.0",
        repositoryHash,
      },
    });

    expect(await forget(repositoryHash)).toEqual({ forgotten: true });
    expect(await forget(repositoryHash)).toEqual({ forgotten: true });
    expect(await forget("d".repeat(64))).toEqual({ forgotten: true });
    const listed = listRepoMemoryOutputSchema.parse(
      (
        await testClient.client.callTool({
          name: "list_repo_memory",
          arguments: { repositoryHash },
        })
      ).structuredContent,
    );
    expect(listed.entries).toEqual([]);
  });
});
