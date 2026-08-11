import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadPublishedCatalog } from "../../../src/catalog/catalog-loader.js";
import { verifyGitHubReleaseBaseline } from "../../../src/catalog/github-release-baseline.js";
import type { CatalogRelease } from "../../../src/domain/catalog/types.js";
import { PROJECT_ROOT } from "../../helpers/catalog-cli.js";

const commit = "c".repeat(40);
const currentChain = readFileSync(
  join(PROJECT_ROOT, "catalog", "advisories.jsonl"),
  "utf8",
);
const currentLines = currentChain.trimEnd().split("\n");
const previousChain = `${currentLines.slice(0, -1).join("\n")}\n`;
const firstLine = currentLines[0];
const secondLine = currentLines[1];
if (firstLine === undefined || secondLine === undefined) {
  throw new Error("Expected at least two genesis advisory events");
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nonGenesisRelease(): CatalogRelease {
  const release = loadPublishedCatalog(
    PROJECT_ROOT,
    "launch-catalog-v1",
  ).release;
  return { ...release, genesis: false, previousReleaseCommit: commit };
}

function githubFetch(
  priorChain = previousChain,
  overrides: {
    readonly releases?: readonly unknown[] | undefined;
    readonly refSha?: string | undefined;
    readonly contentStatus?: number | undefined;
    readonly releasePages?: readonly (readonly unknown[])[] | undefined;
    readonly annotatedTag?: boolean | undefined;
  } = {},
  requests: URL[] = [],
): typeof fetch {
  return async (input) => {
    const resolvedInput = await Promise.resolve(input);
    const url = new URL(
      resolvedInput instanceof Request
        ? resolvedInput.url
        : resolvedInput.toString(),
    );
    requests.push(url);
    if (url.pathname.endsWith("/releases")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return response(
        overrides.releasePages?.[page - 1] ??
          overrides.releases ?? [
            {
              id: 10,
              draft: false,
              prerelease: false,
              published_at: "2026-08-09T00:00:00.000Z",
              tag_name: "v0.9.0",
            },
            {
              id: 12,
              draft: true,
              prerelease: false,
              published_at: "2026-08-11T00:00:00.000Z",
              tag_name: "ignored-draft",
            },
            {
              id: 11,
              draft: false,
              prerelease: true,
              published_at: "2026-08-10T00:00:00.000Z",
              tag_name: "v1.0.0-rc.1",
            },
          ],
      );
    }
    if (url.pathname.includes("/git/ref/tags/")) {
      return response({
        object: {
          type: overrides.annotatedTag ? "tag" : "commit",
          sha: overrides.annotatedTag
            ? "a".repeat(40)
            : (overrides.refSha ?? commit),
        },
      });
    }
    if (url.pathname.includes("/git/tags/")) {
      return response({ object: { type: "commit", sha: commit } });
    }
    if (url.pathname.endsWith("/contents/catalog/advisories.jsonl")) {
      if (overrides.contentStatus !== undefined) {
        return response({ message: "unavailable" }, overrides.contentStatus);
      }
      return response({
        encoding: "base64",
        content: Buffer.from(priorChain, "utf8").toString("base64"),
      });
    }
    return response({ message: "not found" }, 404);
  };
}

describe("GitHub advisory release baseline", () => {
  it("selects the exact latest published non-draft release, including prereleases", async () => {
    const requests: URL[] = [];
    const result = await verifyGitHubReleaseBaseline({
      projectRoot: PROJECT_ROOT,
      release: nonGenesisRelease(),
      repository: "skillwire/skillwire",
      token: "read-only-token",
      apiUrl: "https://api.github.test",
      fetchImplementation: githubFetch(previousChain, {}, requests),
    });

    expect(result).toEqual({
      mode: "non-genesis",
      selectedGitHubReleaseId: 11,
      selectedGitHubPublishedAt: "2026-08-10T00:00:00.000Z",
      resolvedPreviousReleaseCommit: commit,
    });
    const contentRequest = requests.find((url) =>
      url.pathname.endsWith("/contents/catalog/advisories.jsonl"),
    );
    expect(contentRequest?.searchParams.get("ref")).toBe(commit);
    expect(
      requests.some((url) =>
        /branch|merge-base|target_commitish/.test(url.href),
      ),
    ).toBe(false);
  });

  it("accepts genesis only after a successful empty published-release listing", async () => {
    const genesis = loadPublishedCatalog(
      PROJECT_ROOT,
      "launch-catalog-v1",
    ).release;
    await expect(
      verifyGitHubReleaseBaseline({
        projectRoot: PROJECT_ROOT,
        release: genesis,
        repository: "skillwire/skillwire",
        token: "read-only-token",
        apiUrl: "https://api.github.test",
        fetchImplementation: githubFetch(previousChain, { releases: [] }),
      }),
    ).resolves.toMatchObject({ mode: "genesis" });

    await expect(
      verifyGitHubReleaseBaseline({
        projectRoot: PROJECT_ROOT,
        release: genesis,
        repository: "skillwire/skillwire",
        token: "read-only-token",
        apiUrl: "https://api.github.test",
        fetchImplementation: githubFetch(),
      }),
    ).rejects.toThrow("baseline verification failed");
  });

  it("fully paginates releases and peels annotated tags", async () => {
    const drafts = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      draft: true,
      prerelease: false,
      published_at: "2026-08-01T00:00:00.000Z",
      tag_name: `draft-${String(index)}`,
    }));
    const publishedPrerelease = {
      id: 200,
      draft: false,
      prerelease: true,
      published_at: "2026-08-10T00:00:00.000Z",
      tag_name: "v1.0.0-rc.1",
    };
    const requests: URL[] = [];
    const result = await verifyGitHubReleaseBaseline({
      projectRoot: PROJECT_ROOT,
      release: nonGenesisRelease(),
      repository: "skillwire/skillwire",
      token: "read-only-token",
      apiUrl: "https://api.github.test",
      fetchImplementation: githubFetch(
        previousChain,
        {
          releasePages: [drafts, [publishedPrerelease]],
          annotatedTag: true,
        },
        requests,
      ),
    });

    expect(result.selectedGitHubReleaseId).toBe(200);
    expect(
      requests.filter((url) => url.pathname.endsWith("/releases")),
    ).toHaveLength(2);
    expect(requests.some((url) => url.pathname.includes("/git/tags/"))).toBe(
      true,
    );
  });

  it.each([
    ["missing previous release", { releases: [] }],
    ["wrong exact commit", { refSha: "d".repeat(40) }],
    ["unavailable previous chain", { contentStatus: 404 }],
    [
      "ambiguous latest publication time",
      {
        releases: [
          {
            id: 1,
            draft: false,
            prerelease: false,
            published_at: "2026-08-10T00:00:00.000Z",
            tag_name: "v1",
          },
          {
            id: 2,
            draft: false,
            prerelease: true,
            published_at: "2026-08-10T00:00:00.000Z",
            tag_name: "v2-rc",
          },
        ],
      },
    ],
  ] as const)("fails closed for %s", async (_, overrides) => {
    await expect(
      verifyGitHubReleaseBaseline({
        projectRoot: PROJECT_ROOT,
        release: nonGenesisRelease(),
        repository: "skillwire/skillwire",
        token: "read-only-token",
        apiUrl: "https://api.github.test",
        fetchImplementation: githubFetch(previousChain, overrides),
      }),
    ).rejects.toThrow("baseline verification failed");
  });

  it.each([
    ["mutation", previousChain.replace("GENESIS_RELEASE", "MUTATED_EVENT")],
    ["deletion", `${currentLines.slice(1, -1).join("\n")}\n`],
    ["insertion", `${firstLine}\n${previousChain}`],
    [
      "reordering",
      `${secondLine}\n${firstLine}\n${currentLines.slice(2, -1).join("\n")}\n`,
    ],
  ] as const)("rejects prior-prefix %s", async (_, priorChain) => {
    await expect(
      verifyGitHubReleaseBaseline({
        projectRoot: PROJECT_ROOT,
        release: nonGenesisRelease(),
        repository: "skillwire/skillwire",
        token: "read-only-token",
        apiUrl: "https://api.github.test",
        fetchImplementation: githubFetch(priorChain),
      }),
    ).rejects.toThrow("baseline verification failed");
  });
});
