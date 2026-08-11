import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTestApplication } from "../../src/composition.js";
import { snapshotTree } from "../helpers/filesystem-snapshot.js";
import {
  createTestMcpClient,
  TEST_BEARER_TOKEN,
  type TestMcpClient,
} from "../helpers/mcp-client.js";
import { createPublishedCatalogWithStatus } from "../helpers/catalog-cli.js";

const clientTree = fileURLToPath(
  new URL("../fixtures/client-tree/", import.meta.url),
);

async function directClient(
  projectRoot = process.cwd(),
  bearerToken = TEST_BEARER_TOKEN,
): Promise<TestMcpClient> {
  const { app } = createTestApplication({}, projectRoot);
  const appFetch: typeof fetch = async (input, init) => {
    const source = new Request(input, init);
    const headers = new Headers(source.headers);
    headers.set("host", "localhost");
    return app.fetch(new Request(source, { headers }));
  };
  return createTestMcpClient(
    new URL("http://localhost/mcp"),
    appFetch,
    bearerToken,
  );
}

describe("remote delivery never mutates the client tree", () => {
  it("preserves bytes, entry types, and modes across success, failure, and retry", async () => {
    const before = await snapshotTree(clientTree);
    const client = await directClient();
    try {
      const search = await client.client.callTool({
        name: "search_skills",
        arguments: { task: "Review TypeScript type safety", limit: 1 },
      });
      expect(search.isError).not.toBe(true);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const load = await client.client.callTool({
          name: "load_skill",
          arguments: {
            skillId: "typescript-code-review",
            revision: "1.0.0",
          },
        });
        expect(load.isError).not.toBe(true);
      }
      const resource = await client.client.callTool({
        name: "read_skill_resource",
        arguments: {
          skillId: "typescript-code-review",
          revision: "1.0.0",
          path: "references/review-checklist.md",
        },
      });
      expect(resource.isError).not.toBe(true);
      const unknown = await client.client.callTool({
        name: "load_skill",
        arguments: {
          skillId: "typescript-code-review",
          revision: "9.9.9",
        },
      });
      expect(unknown.isError).toBe(true);
    } finally {
      await client.close();
    }
    expect(await snapshotTree(clientTree)).toBe(before);
  });

  it.each(["unavailable", "revoked"] as const)(
    "preserves the tree through %s advisory behavior",
    async (status) => {
      const before = await snapshotTree(clientTree);
      const workspace = createPublishedCatalogWithStatus(status);
      try {
        const client = await directClient(workspace);
        try {
          const result = await client.client.callTool({
            name: "load_skill",
            arguments: {
              skillId: "typescript-code-review",
              revision: "1.0.0",
            },
          });
          expect(result.isError === true).toBe(status === "revoked");
        } finally {
          await client.close();
        }
      } finally {
        rmSync(workspace, { recursive: true });
      }
      expect(await snapshotTree(clientTree)).toBe(before);
    },
  );

  it("preserves the tree when authentication fails", async () => {
    const before = await snapshotTree(clientTree);
    await expect(
      directClient(process.cwd(), "invalid-token"),
    ).rejects.toThrow();
    expect(await snapshotTree(clientTree)).toBe(before);
  });
});
