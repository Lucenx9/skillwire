import { afterEach, describe, expect, it } from "vitest";

import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import { createTestApplication } from "../../../src/composition.js";
import {
  loadSkillOutputSchema,
  searchSkillsOutputSchema,
} from "../../../src/transport/mcp/schemas.js";
import { FakeRepositoryMemoryStore } from "../../helpers/memory-store.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../../helpers/mcp-client.js";

describe("explicit SkillWire request evidence", () => {
  let harness: TestMcpClient | undefined;
  afterEach(async () => harness?.close());

  it("searches once as user-requested and loads the exact eligible preview", async () => {
    const token = createApiKeyToken().token;
    const { app } = createTestApplication({
      memoryStore: new FakeRepositoryMemoryStore(),
      authenticator: {
        authenticate: (candidate) =>
          Promise.resolve(
            candidate === token
              ? {
                  accountId: "00000000-0000-4000-8000-000000000001",
                  apiKeyId: "00000000-0000-4000-8000-000000000002",
                }
              : undefined,
          ),
      },
    });
    harness = await createTestMcpClient(
      new URL("http://localhost/mcp"),
      async (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set("host", "localhost");
        return await app.fetch(new Request(request, { headers }));
      },
      token,
    );
    const search = searchSkillsOutputSchema.parse(
      (
        await harness.client.callTool({
          name: "search_skills",
          arguments: {
            task: "Review strict TypeScript changes",
            limit: 1,
            invocationContext: "user-requested",
          },
        })
      ).structuredContent,
    );
    const preview = search.skills[0];
    expect(preview).toBeDefined();
    const loaded = loadSkillOutputSchema.parse(
      (
        await harness.client.callTool({
          name: "load_skill",
          arguments: {
            skillId: preview?.skillId,
            revision: preview?.revision,
          },
        })
      ).structuredContent,
    );
    expect(loaded).toMatchObject({
      skillId: preview?.skillId,
      revision: preview?.revision,
      currentAdvisoryStatus: preview?.currentAdvisoryStatus,
    });
    expect(loaded.revisionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.publishedProvenance.trustAtPublication).toBe("trusted");
  });
});
