import { GitHubRestClient } from "../src/ingestion/github/rest-client.js";
import { parseClaudePluginManifest } from "../src/ingestion/parsing/claude-plugin-manifest.js";

const ACCEPTANCE_COMMIT = "84fdeffd12f2ee307994d1eb6feb48173b6e0502";

async function main(): Promise<void> {
  const token = process.env["GITHUB_TOKEN"];
  if (token === undefined || token.length < 20) {
    process.stdout.write(
      `${JSON.stringify({ skipped: true, reason: "GITHUB_TOKEN_REQUIRED" })}\n`,
    );
    return;
  }
  const client = new GitHubRestClient({ token });
  const repository = await client.resolvePublicRepository({
    owner: "mattpocock",
    repository: "skills",
  });
  const treeSha = await client.readCommit(repository, ACCEPTANCE_COMMIT);
  const tree = await client.readTree(repository, treeSha, 20_000);
  const manifestEntry = tree.find(
    ({ path, mode, type }) =>
      path === ".claude-plugin/plugin.json" &&
      mode === "100644" &&
      type === "blob",
  );
  if (manifestEntry?.size === undefined) throw new Error("MANIFEST_INVALID");
  const manifestBytes = await client.readBlob(
    repository,
    manifestEntry.sha,
    manifestEntry.size,
  );
  const manifest = parseClaudePluginManifest(manifestBytes);
  if (
    manifest.skillRoots.length !== 25 ||
    manifest.skillRoots.some(
      (skillRoot) =>
        !tree.some(
          ({ path, mode, type }) =>
            path === `${skillRoot}/SKILL.md` &&
            mode === "100644" &&
            type === "blob",
        ),
    )
  ) {
    throw new Error("ACCEPTANCE_INVENTORY_MISMATCH");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      repositoryId: repository.repositoryId,
      commitSha: ACCEPTANCE_COMMIT,
      treeSha,
      skillCount: manifest.skillRoots.length,
    })}\n`,
  );
}

await main();
