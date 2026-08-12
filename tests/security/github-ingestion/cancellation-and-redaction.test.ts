import { describe, expect, it } from "vitest";

import { securityEvent } from "../../../src/observability/audit-events.js";
import {
  REDACTED,
  redactSensitive,
} from "../../../src/observability/redaction.js";
import { GitHubRestClient } from "../../../src/ingestion/github/rest-client.js";

describe("GitHub ingestion cancellation and redaction", () => {
  it("aborts an in-flight streamed response under the complete operation deadline", async () => {
    const startedAt = Date.now();
    const client = new GitHubRestClient({
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                return undefined;
              },
            }),
          ),
        ),
    });
    await expect(
      client.resolvePublicRepository(
        { owner: "safe-owner", repository: "safe-repo" },
        { deadline: Date.now() + 10 },
      ),
    ).rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it("redacts GitHub credentials, coordinates, hashes, paths, URLs, and content", () => {
    const redacted = redactSensitive({
      githubToken: "ghp_raw-secret",
      owner: "secret-owner",
      repository: "secret-repository",
      commitSha: "a".repeat(40),
      blobSha: "b".repeat(40),
      manifestPath: ".claude-plugin/plugin.json",
      licenseText: "secret license",
      attribution: "secret person",
      url: "https://api.github.com/repos/secret-owner/secret-repository",
      content: "skill body",
      safe: { reasonCode: "LICENSE_CONFLICT" },
    });
    expect(redacted).toEqual({
      githubToken: REDACTED,
      owner: REDACTED,
      repository: REDACTED,
      commitSha: REDACTED,
      blobSha: REDACTED,
      manifestPath: REDACTED,
      licenseText: REDACTED,
      attribution: REDACTED,
      url: REDACTED,
      content: REDACTED,
      safe: { reasonCode: "LICENSE_CONFLICT" },
    });
    expect(
      securityEvent("github_ingestion_rejected", {
        sourceId: "550e8400-e29b-41d4-a716-446655440000",
        reasonCode: "LICENSE_CONFLICT",
        state: "quarantined",
        count: 2,
      }),
    ).toEqual({
      event: "github_ingestion_rejected",
      sourceId: "550e8400-e29b-41d4-a716-446655440000",
      reasonCode: "LICENSE_CONFLICT",
      state: "quarantined",
      count: 2,
    });
  });
});
