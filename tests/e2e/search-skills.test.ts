import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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

const clientTree = fileURLToPath(
  new URL("../fixtures/client-tree/", import.meta.url),
);

async function snapshotTree(root: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      hash.update(path.slice(root.length));
      if (entry.isDirectory()) await visit(path);
      else hash.update(await readFile(path));
    }
  }

  await visit(root);
  return hash.digest("hex");
}

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
