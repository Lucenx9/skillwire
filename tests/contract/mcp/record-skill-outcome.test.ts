import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestApplication } from "../../../src/composition.js";
import {
  listRepoMemoryOutputSchema,
  recordSkillOutcomeOutputSchema,
} from "../../../src/transport/mcp/schemas.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../../helpers/mcp-client.js";
import { FakeRepositoryMemoryStore } from "../../helpers/memory-store.js";

const repositoryHash = "b".repeat(64);

describe("record_skill_outcome MCP contract", () => {
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

  it("replaces the prior outcome instead of creating duplicates", async () => {
    await testClient.client.callTool({
      name: "load_skill",
      arguments: {
        skillId: "typescript-code-review",
        revision: "1.0.0",
        repositoryHash,
      },
    });
    for (const outcome of ["neutral", "useful"] as const) {
      const output = recordSkillOutcomeOutputSchema.parse(
        (
          await testClient.client.callTool({
            name: "record_skill_outcome",
            arguments: {
              repositoryHash,
              skillId: "typescript-code-review",
              revision: "1.0.0",
              outcome,
            },
          })
        ).structuredContent,
      );
      expect(output.outcome).toBe(outcome);
    }

    const listed = listRepoMemoryOutputSchema.parse(
      (
        await testClient.client.callTool({
          name: "list_repo_memory",
          arguments: { repositoryHash },
        })
      ).structuredContent,
    );
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.outcome).toBe("useful");
  });

  it("rejects unsupported outcomes and revisions not loaded in the same scope", async () => {
    for (const arguments_ of [
      {
        repositoryHash,
        skillId: "typescript-code-review",
        revision: "1.0.0",
        outcome: "excellent",
      },
      {
        repositoryHash,
        skillId: "typescript-code-review",
        revision: "1.0.0",
        outcome: "useful",
      },
    ]) {
      expect(
        (
          await testClient.client.callTool({
            name: "record_skill_outcome",
            arguments: arguments_,
          })
        ).isError,
      ).toBe(true);
    }
  });
});
