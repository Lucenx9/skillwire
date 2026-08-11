import { describe, expect, it } from "vitest";

import { GitHubCommitTreeBlobReader } from "../../../src/ingestion/github/commit-tree-blob-reader.js";
import { GitHubRestClient } from "../../../src/ingestion/github/rest-client.js";
import { createGitHubIngestionFixture } from "../../helpers/github-ingestion-fixture.js";

describe("exact GitHub commit/tree/blob reader", () => {
  it("pins the mutable default ref once and reads only tree-listed blobs", async () => {
    const fixture = await createGitHubIngestionFixture();
    const reader = new GitHubCommitTreeBlobReader(
      new GitHubRestClient({ fetchImplementation: fixture.fetch }),
    );
    const repository = await reader.resolvePublicRepository({
      owner: "mattpocock",
      repository: "skills",
    });
    const snapshot = await reader.readDefaultSnapshot(repository);
    expect(snapshot.commitSha).toBe(fixture.inventory.commitSha);
    expect(snapshot.treeSha).toBe(fixture.treeSha);
    expect(snapshot.tree).toHaveLength(fixture.treeEntryCount);
    const manifest = fixture.files.get(".claude-plugin/plugin.json");
    if (manifest === undefined) throw new Error("Fixture manifest missing");
    await expect(
      reader.readBlob(repository, manifest.sha, manifest.size),
    ).resolves.toEqual(new TextEncoder().encode(manifest.content));
    expect(
      fixture.calls.every(({ url }) =>
        url.startsWith("https://api.github.com/"),
      ),
    ).toBe(true);
  });

  it("rejects truncated, ambiguous, unsafe, or oversized trees", async () => {
    const identity = {
      repositoryId: 1,
      owner: "mattpocock",
      repository: "skills",
      defaultBranch: "main",
    } as const;
    const treeSha = "1".repeat(40);
    for (const body of [
      { sha: treeSha, truncated: true, tree: [] },
      {
        sha: treeSha,
        truncated: false,
        tree: [
          {
            path: "a/SKILL.md",
            mode: "100644",
            type: "blob",
            sha: "2".repeat(40),
            size: 1,
          },
          {
            path: "A/skill.md",
            mode: "100644",
            type: "blob",
            sha: "3".repeat(40),
            size: 1,
          },
        ],
      },
      {
        sha: treeSha,
        truncated: false,
        tree: [
          {
            path: "../SKILL.md",
            mode: "100644",
            type: "blob",
            sha: "2".repeat(40),
            size: 1,
          },
        ],
      },
    ]) {
      const client = new GitHubRestClient({
        fetchImplementation: () =>
          Promise.resolve(new Response(JSON.stringify(body))),
      });
      await expect(client.readTree(identity, treeSha, 1)).rejects.toThrow();
    }
  });
});
