import { describe, expect, it } from "vitest";

import { securityEvent } from "../../../src/observability/audit-events.js";
import { createSecurityLogger } from "../../../src/observability/logger.js";
import {
  REDACTED,
  redactSensitive,
} from "../../../src/observability/redaction.js";

describe("security log redaction", () => {
  it("recursively removes credentials, repositories, queries, content, and paths", () => {
    const repositoryHash = "a".repeat(64);
    const value = redactSensitive({
      authorization: "Bearer raw-secret",
      nested: {
        repositoryHash,
        query: "private task text",
        resourceBody: "private skill content",
        localPath: "/home/private/repository",
        safeCode: "NOT_FOUND",
      },
      disguised: `Bearer hidden-token ${repositoryHash}`,
    });

    expect(value).toEqual({
      authorization: REDACTED,
      nested: {
        repositoryHash: REDACTED,
        query: REDACTED,
        resourceBody: REDACTED,
        localPath: REDACTED,
        safeCode: "NOT_FOUND",
      },
      disguised: REDACTED,
    });
  });

  it("emits allowlisted structured fields only", () => {
    let output = "";
    const logger = createSecurityLogger({
      write(chunk) {
        output += chunk;
      },
    });
    logger.emit("tool_failed", {
      requestId: "00000000-0000-4000-8000-000000000001",
      accountId: "00000000-0000-4000-8000-000000000002",
      apiKeyId: "00000000-0000-4000-8000-000000000003",
      code: "NOT_FOUND",
      tool: "load_skill",
    });

    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event: "tool_failed",
      code: "NOT_FOUND",
      tool: "load_skill",
    });
    expect(JSON.stringify(parsed)).not.toMatch(
      /authorization|repositoryHash|query|content|localPath|resourceBody/i,
    );
    expect(
      securityEvent("tool_failed", { tool: "attacker-controlled-tool" }),
    ).not.toHaveProperty("tool");
  });
});
