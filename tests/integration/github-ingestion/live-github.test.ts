import { describe, expect, it } from "vitest";

import { GitHubRestClient } from "../../../src/ingestion/github/rest-client.js";

const enabled =
  process.env["SKILLWIRE_RUN_LIVE_GITHUB_SMOKE"] === "1" &&
  process.env["SKILLWIRE_BLOCK_GITHUB_NETWORK"] === "false" &&
  typeof process.env["GITHUB_TOKEN"] === "string" &&
  process.env["GITHUB_TOKEN"] !== "";

describe.skipIf(!enabled)("optional live GitHub fixed-commit smoke", () => {
  it("reads the acceptance commit only from the official API", async () => {
    const client = new GitHubRestClient({ token: process.env["GITHUB_TOKEN"] });
    const repository = await client.resolvePublicRepository({
      owner: "mattpocock",
      repository: "skills",
    });
    const commit = "84fdeffd12f2ee307994d1eb6feb48173b6e0502";
    const treeSha = await client.readCommit(repository, commit);
    const tree = await client.readTree(repository, treeSha, 20_000);
    expect(tree.some(({ path }) => path === ".claude-plugin/plugin.json")).toBe(
      true,
    );
  }, 120_000);
});
