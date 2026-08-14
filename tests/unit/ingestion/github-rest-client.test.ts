import { describe, expect, it } from "vitest";

import {
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  GitHubRestClient,
} from "../../../src/ingestion/github/rest-client.js";
import { createGitHubIngestionFixture } from "../../helpers/github-ingestion-fixture.js";

const repository = {
  repositoryId: 1148788086,
  owner: "mattpocock",
  repository: "skills",
  defaultBranch: "main",
} as const;

describe("fixed-origin GitHub REST client", () => {
  it("uses only the official origin, pinned headers, and manual redirects", async () => {
    const fixture = await createGitHubIngestionFixture();
    const client = new GitHubRestClient({
      token: "fixture-token",
      fetchImplementation: fixture.fetch,
    });
    await expect(
      client.resolvePublicRepository({
        owner: "mattpocock",
        repository: "skills",
      }),
    ).resolves.toEqual(repository);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      method: "GET",
      apiVersion: GITHUB_API_VERSION,
      accept: "application/vnd.github+json",
      authorization: "Bearer fixture-token",
      redirect: "manual",
    });
    expect(
      fixture.calls[0]?.url.startsWith(`${GITHUB_API_ORIGIN}/repos/`),
    ).toBe(true);
  });

  it("rejects arbitrary coordinates and cross-origin redirects", async () => {
    const client = new GitHubRestClient({
      fetchImplementation: () =>
        Promise.resolve(
          new Response(null, {
            status: 301,
            headers: {
              location: "https://evil.example/repos/mattpocock/skills",
            },
          }),
        ),
    });
    await expect(
      client.resolvePublicRepository({
        owner: "https://evil.example",
        repository: "skills",
      }),
    ).rejects.toThrow("INVALID_GITHUB_COORDINATE");
    await expect(
      client.resolvePublicRepository({
        owner: "mattpocock",
        repository: "skills",
      }),
    ).rejects.toThrow("REDIRECT_REJECTED");
  });

  it("allows exactly one validated same-origin repository rename redirect", async () => {
    const calls: string[] = [];
    const client = new GitHubRestClient({
      fetchImplementation: (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        calls.push(url.href);
        if (calls.length === 1) {
          return Promise.resolve(
            new Response(null, {
              status: 301,
              headers: { location: "/repos/mattpocock/skills" },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 1148788086,
              name: "skills",
              private: false,
              default_branch: "main",
              owner: { login: "mattpocock" },
            }),
          ),
        );
      },
    });
    await expect(
      client.resolvePublicRepository({
        owner: "old-owner",
        repository: "skills",
      }),
    ).resolves.toEqual(repository);
    expect(calls).toEqual([
      "https://api.github.com/repos/old-owner/skills",
      "https://api.github.com/repos/mattpocock/skills",
    ]);
  });

  it("enforces streamed byte budgets and whole-body deadlines", async () => {
    const oversized = new GitHubRestClient({
      maximumResponseBytes: 8,
      fetchImplementation: () =>
        Promise.resolve(new Response('{"private":false}', { status: 200 })),
    });
    await expect(
      oversized.resolvePublicRepository({
        owner: "mattpocock",
        repository: "skills",
      }),
    ).rejects.toThrow("RESPONSE_OVERSIZED");

    const slow = new GitHubRestClient({
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                setTimeout(() => {
                  controller.enqueue(new TextEncoder().encode("{}"));
                }, 100);
              },
            }),
          ),
        ),
    });
    await expect(
      slow.resolvePublicRepository(
        { owner: "mattpocock", repository: "skills" },
        { deadline: Date.now() + 10 },
      ),
    ).rejects.toBeDefined();
  });

  it("rejects mismatched tree and blob object hashes", async () => {
    const treeClient = new GitHubRestClient({
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ sha: "2".repeat(40), truncated: false, tree: [] }),
          ),
        ),
    });
    await expect(
      treeClient.readTree(repository, "1".repeat(40), 10),
    ).rejects.toThrow("HASH_MISMATCH");

    const blobClient = new GitHubRestClient({
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              sha: "2".repeat(40),
              size: 3,
              encoding: "base64",
              content: "YWJj",
            }),
          ),
        ),
    });
    await expect(
      blobClient.readBlob(repository, "1".repeat(40), 3),
    ).rejects.toThrow("HASH_MISMATCH");

    const replacedBlob = new GitHubRestClient({
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              sha: "1".repeat(40),
              size: 3,
              encoding: "base64",
              content: "YWJj",
            }),
          ),
        ),
    });
    await expect(
      replacedBlob.readBlob(repository, "1".repeat(40), 3),
    ).rejects.toThrow("HASH_MISMATCH");
  });

  it("retries bounded rate/transient responses using shared headers and budgets", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new GitHubRestClient({
      sleepImplementation(milliseconds) {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      fetchImplementation: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            new Response(null, {
              status: 429,
              headers: { "retry-after": "0" },
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 1148788086,
              name: "skills",
              private: false,
              default_branch: "main",
              owner: { login: "mattpocock" },
            }),
          ),
        );
      },
    });
    const budget = {
      requests: 0,
      retries: 0,
      responseBytes: 0,
      maximumRequests: 2,
      maximumRetries: 1,
      maximumResponseBytes: 4096,
    };
    await expect(
      client.resolvePublicRepository(
        { owner: "mattpocock", repository: "skills" },
        { budget },
      ),
    ).resolves.toEqual(repository);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([0]);
    expect(budget).toMatchObject({ requests: 2, retries: 1 });
  });

  it("does not sleep past a deadline or retry ordinary not-found responses", async () => {
    let calls = 0;
    const deadlineClient = new GitHubRestClient({
      now: () => 1_000,
      fetchImplementation: () =>
        Promise.resolve(
          new Response(null, { status: 429, headers: { "retry-after": "10" } }),
        ),
    });
    await expect(
      deadlineClient.resolvePublicRepository(
        { owner: "mattpocock", repository: "skills" },
        { deadline: 1_100 },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    const notFound = new GitHubRestClient({
      fetchImplementation: () => {
        calls += 1;
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    });
    await expect(
      notFound.resolvePublicRepository({
        owner: "mattpocock",
        repository: "skills",
      }),
    ).rejects.toThrow("GITHUB_HTTP_404");
    expect(calls).toBe(1);
  });

  it("fails when a rate-limit retry would exceed the shared retry budget", async () => {
    const client = new GitHubRestClient({
      fetchImplementation: () =>
        Promise.resolve(
          new Response(null, { status: 429, headers: { "retry-after": "0" } }),
        ),
    });
    await expect(
      client.resolvePublicRepository(
        { owner: "mattpocock", repository: "skills" },
        {
          budget: {
            requests: 0,
            retries: 0,
            responseBytes: 0,
            maximumRequests: 2,
            maximumRetries: 0,
            maximumResponseBytes: 4096,
          },
        },
      ),
    ).rejects.toThrow("RETRY_BUDGET_EXCEEDED");
  });
});
