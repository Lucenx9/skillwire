import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import { createTestApplication } from "../../src/composition.js";
import { searchSkillsOutputSchema } from "../../src/transport/mcp/schemas.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../helpers/mcp-client.js";
import { snapshotTree } from "../helpers/filesystem-snapshot.js";

const clientTree = fileURLToPath(
  new URL("../fixtures/client-tree/", import.meta.url),
);

describe("authenticated search client journey", () => {
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

  it("searches through a real Streamable HTTP client without changing the client tree", async () => {
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

    const result = await testClient.client.callTool({
      name: "search_skills",
      arguments: {
        task: "Harden a Dockerfile and remove root privileges",
        limit: 2,
      },
    });
    const output = searchSkillsOutputSchema.parse(result.structuredContent);

    expect(output.skills[0]?.skillId).toBe("dockerfile-hardening");
    expect(await snapshotTree(clientTree)).toBe(before);
  });
});
