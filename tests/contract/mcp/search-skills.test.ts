import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestApplication } from "../../../src/composition.js";
import { searchSkillsOutputSchema } from "../../../src/transport/mcp/schemas.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../../helpers/mcp-client.js";
import { importedCatalogFixture } from "../../helpers/imported-catalog-provider.js";
import {
  loadActivationFixtures,
  validateActivationFixtures,
} from "../../../src/evaluation/activation-corpus-runner.js";

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

  it("exposes only the implemented progressive catalog tools", async () => {
    const { tools } = await client().client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "search_skills",
      "load_skill",
      "read_skill_resource",
      "list_repo_memory",
      "record_skill_outcome",
      "forget_repo_memory",
    ]);
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
    const discovered = new Set<string>();
    for (const task of [
      "dependency upgrades",
      "Dockerfile",
      "GitHub Actions",
      "Node.js API",
      "PostgreSQL schema",
      "React accessibility",
      "technical documentation",
      "threat modeling",
      "TypeScript review",
      "Vitest tests",
    ]) {
      const result = await client().client.callTool({
        name: "search_skills",
        arguments: { task, limit: 10 },
      });
      for (const skill of searchSkillsOutputSchema.parse(
        result.structuredContent,
      ).skills) {
        discovered.add(skill.skillId);
      }
    }

    expect(discovered.size).toBe(10);
  });

  it("returns an empty list when no catalog text is relevant", async () => {
    for (const task of [
      "quasar xylophone zephyr",
      "Alphabetize apple, banana, and cherry.",
      "Replace commas with semicolons.",
    ]) {
      const result = await client().client.callTool({
        name: "search_skills",
        arguments: { task, limit: 10 },
      });

      expect(
        searchSkillsOutputSchema.parse(result.structuredContent).skills,
      ).toEqual([]);
    }
  });

  it("rejects unknown input properties", async () => {
    const result = await client().client.callTool({
      name: "search_skills",
      arguments: { task: "TypeScript review", extra: true },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("defaults to automatic invocation and requires explicit user intent for user-only imports", async () => {
    await testClient?.close();
    const { app } = createTestApplication({
      importedCatalogProvider: importedCatalogFixture.provider,
    });
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

    const automatic = await client().client.callTool({
      name: "search_skills",
      arguments: { task: "ask matt", limit: 10 },
    });
    expect(
      searchSkillsOutputSchema.parse(automatic.structuredContent).skills,
    ).toEqual([]);

    const requested = await client().client.callTool({
      name: "search_skills",
      arguments: {
        task: "ask matt",
        invocationContext: "user-requested",
        limit: 10,
      },
    });
    expect(
      searchSkillsOutputSchema.parse(requested.structuredContent).skills[0],
    ).toMatchObject({
      skillId: importedCatalogFixture.userOnlyId,
      trustAtPublication: "structurally-verified",
      currentClassification: "verified",
      invocationMode: "user-only",
      catalogOrigin: {
        kind: "github",
        owner: "mattpocock",
        repository: "skills",
      },
    });
  });

  it("enforces every frozen explicit/no-intent isolation pair", async () => {
    await testClient?.close();
    const { app } = createTestApplication({
      importedCatalogProvider: importedCatalogFixture.provider,
    });
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
    const { corpus } = validateActivationFixtures(
      loadActivationFixtures(process.cwd()),
    );

    for (const explicit of corpus.cases.filter(
      ({ scenarioClass }) => scenarioClass === "user-requested-explicit",
    )) {
      const withoutIntent = corpus.cases.find(
        ({ pairId, scenarioClass }) =>
          pairId === explicit.pairId &&
          scenarioClass === "user-requested-without-intent",
      );
      expect(withoutIntent).toBeDefined();

      for (const invocationContext of [undefined, "automatic"] as const) {
        const result = searchSkillsOutputSchema.parse(
          (
            await client().client.callTool({
              name: "search_skills",
              arguments: {
                task: withoutIntent?.prompt,
                limit: 10,
                ...(invocationContext === undefined
                  ? {}
                  : { invocationContext }),
              },
            })
          ).structuredContent,
        );
        expect(
          result.skills.some(
            ({ skillId }) => skillId === explicit.expectedCatalogMatch?.skillId,
          ),
        ).toBe(false);
      }

      const requested = searchSkillsOutputSchema.parse(
        (
          await client().client.callTool({
            name: "search_skills",
            arguments: {
              task: explicit.prompt,
              invocationContext: "user-requested",
              limit: 10,
            },
          })
        ).structuredContent,
      );
      expect(requested.skills[0]).toMatchObject({
        skillId: explicit.expectedCatalogMatch?.skillId,
        revision: explicit.expectedCatalogMatch?.revision,
        invocationMode: "user-only",
        currentClassification: "verified",
      });
    }
  });
});
