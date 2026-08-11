import { describe, expect, it } from "vitest";

import { createTestApplication } from "../../../src/composition.js";
import { TEST_BEARER_TOKEN } from "../../helpers/mcp-client.js";

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "contract-test", version: "1.0.0" },
  },
});

describe("Streamable HTTP boundary", () => {
  it.each([undefined, "Basic abc", "Bearer wrong-token"])(
    "returns the same 401 response for invalid authorization %s",
    async (authorization) => {
      const { app } = createTestApplication();
      const headers = new Headers({
        "content-type": "application/json",
        host: "127.0.0.1",
      });
      if (authorization !== undefined)
        headers.set("authorization", authorization);

      const response = await app.request("/mcp", {
        method: "POST",
        headers,
        body: initializeBody,
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      const body = (await response.json()) as unknown;
      expect(body).toMatchObject({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required.",
          retryable: false,
        },
      });
      expect(JSON.stringify(body)).toMatch(
        /"requestId":"[0-9a-f]{8}-[0-9a-f-]{27}"/,
      );
    },
  );

  it("does not expose session methods", async () => {
    const { app } = createTestApplication();
    const headers = {
      authorization: `Bearer ${TEST_BEARER_TOKEN}`,
      host: "127.0.0.1",
    };

    expect((await app.request("/mcp", { method: "GET", headers })).status).toBe(
      405,
    );
    expect(
      (await app.request("/mcp", { method: "DELETE", headers })).status,
    ).toBe(405);
  });

  it("reports liveness without authentication", async () => {
    const { app } = createTestApplication();

    const response = await app.request("/health/live", {
      headers: { host: "127.0.0.1" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
