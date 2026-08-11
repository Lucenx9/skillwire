import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiKeyToken } from "../../src/authentication/api-key-token.js";
import { createApplication, type Application } from "../../src/composition.js";
import { PostgresApiKeyStore } from "../../src/persistence/postgres/api-key-store.js";
import {
  loadSkillOutputSchema,
  readSkillResourceOutputSchema,
  searchSkillsOutputSchema,
} from "../../src/transport/mcp/schemas.js";
import { snapshotTree } from "../helpers/filesystem-snapshot.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../helpers/mcp-client.js";
import {
  createPublishedImportedCatalog,
  type PublishedImportedCatalog,
} from "../helpers/published-imported-catalog.js";

const pepper = "github-ingestion-e2e-pepper-at-least-thirty-two-bytes";
const clientTree = fileURLToPath(
  new URL("../fixtures/client-tree/", import.meta.url),
);

describe("remote GitHub catalog MCP journey", () => {
  let catalog: PublishedImportedCatalog;
  let application: Application;
  let client: TestMcpClient;
  let secondClient: TestMcpClient;

  beforeAll(async () => {
    catalog = await createPublishedImportedCatalog();
    const keys = new PostgresApiKeyStore(catalog.database.pool, pepper);
    const firstAccount = randomUUID();
    const secondAccount = randomUUID();
    const firstToken = createApiKeyToken();
    const secondToken = createApiKeyToken();
    await keys.createAccount(firstAccount);
    await keys.createAccount(secondAccount);
    await keys.createKey(randomUUID(), firstAccount, firstToken);
    await keys.createKey(randomUUID(), secondAccount, secondToken);
    application = await createApplication({
      host: "127.0.0.1",
      port: 0,
      databaseUrl: catalog.database.connectionString,
      apiKeyPepper: pepper,
    });
    const appFetch: typeof fetch = async (input, init) => {
      const source = new Request(input, init);
      const headers = new Headers(source.headers);
      headers.set("host", "127.0.0.1");
      return application.app.fetch(new Request(source, { headers }));
    };
    client = await createTestMcpClient(
      new URL("http://127.0.0.1/mcp"),
      appFetch,
      firstToken.token,
    );
    secondClient = await createTestMcpClient(
      new URL("http://127.0.0.1/mcp"),
      appFetch,
      secondToken.token,
    );
  }, 120_000);

  afterAll(async () => {
    await client.close();
    await secondClient.close();
    await application.close();
    await catalog.database.close();
  });

  it("completes search, exact load, and progressive resource in three calls without client writes or GitHub", async () => {
    const before = await snapshotTree(clientTree);
    const githubCalls = catalog.githubCallCount();
    const search = await client.client.callTool({
      name: "search_skills",
      arguments: {
        task: "ask matt",
        invocationContext: "user-requested",
        limit: 1,
      },
    });
    const preview = searchSkillsOutputSchema.parse(search.structuredContent)
      .skills[0];
    expect(preview).toMatchObject({
      name: "ask-matt",
      invocationMode: "user-only",
      catalogOrigin: {
        owner: "mattpocock",
        repository: "skills",
        commitSha: "84fdeffd12f2ee307994d1eb6feb48173b6e0502",
      },
    });
    if (preview === undefined) throw new Error("missing fixture skill");
    const load = await client.client.callTool({
      name: "load_skill",
      arguments: { skillId: preview.skillId, revision: preview.revision },
    });
    const loaded = loadSkillOutputSchema.parse(load.structuredContent);
    expect(loaded).toMatchObject({
      currentClassification: "verified",
      publishedProvenance: {
        license: "MIT",
        owner: "Matt Pocock",
        trustAtPublication: "structurally-verified",
      },
      resourceManifest: [{ path: "PHASE-BOUNDARIES.md" }],
    });
    const resource = await client.client.callTool({
      name: "read_skill_resource",
      arguments: {
        skillId: preview.skillId,
        revision: preview.revision,
        path: "PHASE-BOUNDARIES.md",
      },
    });
    expect(
      readSkillResourceOutputSchema.parse(resource.structuredContent),
    ).toMatchObject({ path: "PHASE-BOUNDARIES.md" });
    expect(catalog.githubCallCount()).toBe(githubCalls);
    expect(await snapshotTree(clientTree)).toBe(before);
  });

  it("returns exact dependency revisions and isolates imported repository memory", async () => {
    const search = await client.client.callTool({
      name: "search_skills",
      arguments: {
        task: "grill with docs",
        invocationContext: "user-requested",
        limit: 1,
      },
    });
    const preview = searchSkillsOutputSchema.parse(search.structuredContent)
      .skills[0];
    if (preview === undefined) throw new Error("missing fixture skill");
    const repositoryHash = "b".repeat(64);
    const loaded = loadSkillOutputSchema.parse(
      (
        await client.client.callTool({
          name: "load_skill",
          arguments: {
            skillId: preview.skillId,
            revision: preview.revision,
            repositoryHash,
          },
        })
      ).structuredContent,
    );
    expect(loaded.dependencies?.map(({ skillId }) => skillId)).toHaveLength(2);
    expect(
      loaded.dependencies?.map(({ evidenceKind }) => evidenceKind),
    ).toEqual(["explicit-invocation", "explicit-invocation"]);

    const ownMemory = await client.client.callTool({
      name: "list_repo_memory",
      arguments: { repositoryHash },
    });
    expect(ownMemory.structuredContent).toMatchObject({
      entries: [{ skillId: preview.skillId, revision: preview.revision }],
    });
    const isolated = await secondClient.client.callTool({
      name: "list_repo_memory",
      arguments: { repositoryHash },
    });
    expect(isolated.structuredContent).toMatchObject({ entries: [] });
    const otherRepository = await client.client.callTool({
      name: "list_repo_memory",
      arguments: { repositoryHash: "c".repeat(64) },
    });
    expect(otherRepository.structuredContent).toMatchObject({ entries: [] });

    await client.client.callTool({
      name: "forget_repo_memory",
      arguments: { repositoryHash },
    });
    const erased = await client.client.callTool({
      name: "list_repo_memory",
      arguments: { repositoryHash },
    });
    expect(erased.structuredContent).toMatchObject({ entries: [] });
  });
});
