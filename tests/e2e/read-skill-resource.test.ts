import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import { createTestApplication } from "../../src/composition.js";
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

const clientTree = fileURLToPath(
  new URL("../fixtures/client-tree/", import.meta.url),
);

describe("progressive authenticated catalog journey", () => {
  let server: Server | undefined;
  let testClient: TestMcpClient | undefined;

  afterEach(async () => {
    await testClient?.close();
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("searches, loads, and reads one resource in three calls without changing the client tree", async () => {
    const before = await snapshotTree(clientTree);
    const { app } = createTestApplication();
    server = serve({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: 0,
    }) as Server;
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address() as AddressInfo;
    testClient = await createTestMcpClient(
      new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
    );
    let callCount = 0;

    callCount += 1;
    const search = searchSkillsOutputSchema.parse(
      (
        await testClient.client.callTool({
          name: "search_skills",
          arguments: { task: "Review strict TypeScript narrowing", limit: 1 },
        })
      ).structuredContent,
    );
    const selected = search.skills[0];
    expect(selected).toBeDefined();

    callCount += 1;
    const loaded = loadSkillOutputSchema.parse(
      (
        await testClient.client.callTool({
          name: "load_skill",
          arguments: {
            skillId: selected?.skillId,
            revision: selected?.revision,
          },
        })
      ).structuredContent,
    );

    callCount += 1;
    const resource = readSkillResourceOutputSchema.parse(
      (
        await testClient.client.callTool({
          name: "read_skill_resource",
          arguments: {
            skillId: loaded.skillId,
            revision: loaded.revision,
            path: loaded.resourceManifest[0]?.path,
          },
        })
      ).structuredContent,
    );

    expect(callCount).toBeLessThanOrEqual(3);
    expect(resource.sha256).toBe(loaded.resourceManifest[0]?.sha256);
    expect(resource.content).toContain("TypeScript review checklist");
    expect(await snapshotTree(clientTree)).toBe(before);
  });
});
