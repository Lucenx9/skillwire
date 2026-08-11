import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createTestApplication } from "../../../src/composition.js";
import type {
  SecurityEventFields,
  SecurityEventName,
} from "../../../src/observability/audit-events.js";
import type { SecurityLogger } from "../../../src/observability/logger.js";
import {
  createTestMcpClient,
  TEST_BEARER_TOKEN,
  type TestMcpClient,
} from "../../helpers/mcp-client.js";

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "security-test", version: "1.0.0" },
  },
});

function capturingLogger() {
  const events: { event: SecurityEventName; fields?: SecurityEventFields }[] =
    [];
  const logger: SecurityLogger = {
    emit(event, fields) {
      events.push({ event, ...(fields === undefined ? {} : { fields }) });
    },
  };
  return { logger, events };
}

async function connectedClient(
  options: Parameters<typeof createTestApplication>[0] = {},
): Promise<TestMcpClient> {
  const { app } = createTestApplication(options);
  const appFetch: typeof fetch = async (input, init) => {
    const source = new Request(input, init);
    const headers = new Headers(source.headers);
    headers.set("host", "localhost");
    return app.fetch(new Request(source, { headers }));
  };
  return createTestMcpClient(new URL("http://localhost/mcp"), appFetch);
}

describe("host, schema, size, rate, and execution boundaries", () => {
  const clients: TestMcpClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it("rejects hostile hosts and oversized bodies before authentication", async () => {
    const { app } = createTestApplication({ maximumRequestBodyBytes: 128 });
    const hostile = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_BEARER_TOKEN}`,
        "content-type": "application/json",
        host: "attacker.example",
      },
      body: initializeBody,
    });
    expect(hostile.status).toBe(403);

    const oversized = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_BEARER_TOKEN}`,
        "content-type": "application/json",
        host: "127.0.0.1",
      },
      body: JSON.stringify({ value: "x".repeat(512) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "INVALID_ARGUMENT", retryable: false },
    });
  });

  it("enforces the configured authenticated key rate limit", async () => {
    const { app } = createTestApplication({
      rateLimit: {
        accountRequestsPerMinute: 1,
        apiKeyRequestsPerMinute: 1,
        burst: 1,
      },
    });
    const request = () =>
      app.request("/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TEST_BEARER_TOKEN}`,
          "content-type": "application/json",
          host: "127.0.0.1",
        },
        body: initializeBody,
      });

    expect((await request()).status).toBe(200);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED", retryable: true },
    });
  });

  it("fails closed before dispatch when the request deadline is exhausted", async () => {
    let current = 0;
    const { app } = createTestApplication({
      requestDeadlineMilliseconds: 1,
      now: () => {
        current += 1;
        return current;
      },
    });
    const response = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_BEARER_TOKEN}`,
        "content-type": "application/json",
        host: "127.0.0.1",
      },
      body: initializeBody,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INTERNAL", retryable: true },
    });
  });

  it("rejects malformed, oversized, traversal, URL, and unknown-revision inputs", async () => {
    const client = await connectedClient();
    clients.push(client);
    for (const request of [
      {
        name: "search_skills",
        arguments: { task: "x".repeat(4097) },
      },
      {
        name: "search_skills",
        arguments: { task: "review", url: "http://127.0.0.1/private" },
      },
      {
        name: "read_skill_resource",
        arguments: {
          skillId: "typescript-code-review",
          revision: "1.0.0",
          path: "../SKILL.md",
        },
      },
    ]) {
      const result = await client.client.callTool(request);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    }

    const unknown = await client.client.callTool({
      name: "load_skill",
      arguments: { skillId: "typescript-code-review", revision: "9.9.9" },
    });
    expect(unknown.isError).toBe(true);
    const text = unknown.content.find((entry) => entry.type === "text");
    if (text?.type !== "text") throw new Error("Expected safe tool error");
    expect(JSON.parse(text.text)).toMatchObject({
      error: { code: "NOT_FOUND", retryable: false },
    });
  });

  it("never records secrets or request-controlled private data in security events", async () => {
    const { logger, events } = capturingLogger();
    const { app } = createTestApplication({ logger });
    const repositoryHash = "a".repeat(64);
    await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer raw-api-key-secret",
        "content-type": "application/json",
        host: "127.0.0.1",
      },
      body: JSON.stringify({
        query: "private query",
        repositoryHash,
        content: "private skill body",
        path: "/home/private/repository",
      }),
    });

    const serialized = JSON.stringify(events);
    expect(serialized).toContain("authentication_failed");
    expect(serialized).not.toContain("raw-api-key-secret");
    expect(serialized).not.toContain(repositoryHash);
    expect(serialized).not.toContain("private query");
    expect(serialized).not.toContain("private skill body");
    expect(serialized).not.toContain("/home/private/repository");
  });

  it("keeps production request paths free of execution and package-install capabilities", () => {
    const sourceFiles = [
      "src/transport/mcp/app.ts",
      "src/transport/mcp/server-factory.ts",
      "src/transport/mcp/tool-adapters.ts",
      "src/catalog/version-controlled-provider.ts",
      "src/application/use-cases/load-skill.ts",
      "src/application/use-cases/read-skill-resource.ts",
    ];
    const productionSource = sourceFiles
      .map((path) => readFileSync(join(process.cwd(), path), "utf8"))
      .join("\n");

    for (const forbidden of [
      "node:child_process",
      "node:vm",
      "exec(",
      "spawn(",
      "eval(",
      "npm install",
      "pnpm install",
      "catalog:publish",
    ]) {
      expect(productionSource).not.toContain(forbidden);
    }
  });
});
