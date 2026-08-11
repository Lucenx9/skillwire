import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import { createTestApplication } from "../../src/composition.js";
import { loadSkillOutputSchema } from "../../src/transport/mcp/schemas.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../helpers/mcp-client.js";

describe("load_skill authenticated HTTP journey", () => {
  let server: Server | undefined;
  let client: TestMcpClient | undefined;

  afterEach(async () => {
    await client?.close();
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("loads one exact immutable revision through the official MCP client", async () => {
    const { app } = createTestApplication();
    server = serve({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: 0,
    }) as Server;
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address() as AddressInfo;
    client = await createTestMcpClient(
      new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
    );

    const result = loadSkillOutputSchema.parse(
      (
        await client.client.callTool({
          name: "load_skill",
          arguments: {
            skillId: "typescript-code-review",
            revision: "1.0.0",
          },
        })
      ).structuredContent,
    );

    expect(result).toMatchObject({
      skillId: "typescript-code-review",
      revision: "1.0.0",
      memoryRecorded: false,
      currentAdvisoryStatus: "available",
    });
    expect(result.revisionSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
