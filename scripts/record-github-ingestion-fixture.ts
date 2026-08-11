import { posix } from "node:path";

import { parseClaudePluginManifest } from "../src/ingestion/parsing/claude-plugin-manifest.js";
import { extractTextualResourceReferences } from "../src/ingestion/parsing/markdown-resources.js";

const ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";
const OWNER = "mattpocock";
const REPOSITORY = "skills";
const COMMIT_SHA = "84fdeffd12f2ee307994d1eb6feb48173b6e0502";

interface RecordedResponse {
  readonly method: "GET";
  readonly path: string;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly size?: number | undefined;
}

interface TreeResponse {
  readonly sha: string;
  readonly truncated: boolean;
  readonly tree: readonly TreeEntry[];
}

interface BlobResponse {
  readonly sha: string;
  readonly size: number;
  readonly encoding: "base64";
  readonly content: string;
}

const responses: RecordedResponse[] = [];

async function get(path: string): Promise<unknown> {
  if (!path.startsWith("/repos/mattpocock/skills")) {
    throw new Error("Recorder path escaped fixed repository");
  }
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "SkillWire-fixture-recorder/0.1.0",
  });
  const token = process.env["GITHUB_TOKEN"];
  if (token !== undefined && token.length > 0) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${ORIGIN}${path}`, {
    method: "GET",
    headers,
    redirect: "error",
  });
  const body = (await response.json()) as unknown;
  responses.push({
    method: "GET",
    path,
    status: response.status,
    etag: response.headers.get("etag"),
    body,
  });
  if (!response.ok)
    throw new Error(
      `GitHub fixture request failed: ${String(response.status)}`,
    );
  return body;
}

function asTree(value: unknown): TreeResponse {
  const tree = value as TreeResponse;
  if (tree.truncated || tree.sha.length !== 40 || !Array.isArray(tree.tree)) {
    throw new Error("Invalid or truncated fixture tree");
  }
  return tree;
}

function asBlob(value: unknown, expectedSha: string): BlobResponse {
  const blob = value as BlobResponse;
  if (blob.sha !== expectedSha) {
    throw new Error("Fixture blob mismatch");
  }
  return blob;
}

function regularBlob(tree: TreeResponse, path: string): TreeEntry {
  const entry = tree.tree.find((candidate) => candidate.path === path);
  if (
    entry?.type !== "blob" ||
    entry.mode !== "100644" ||
    entry.size === undefined
  ) {
    throw new Error(`Required regular blob missing: ${path}`);
  }
  return entry;
}

function decode(blob: BlobResponse): Uint8Array {
  const bytes = Uint8Array.from(
    Buffer.from(blob.content.replaceAll(/\s/g, ""), "base64"),
  );
  if (bytes.byteLength !== blob.size)
    throw new Error("Fixture blob size mismatch");
  return bytes;
}

async function recordBlob(
  tree: TreeResponse,
  path: string,
): Promise<BlobResponse> {
  const entry = regularBlob(tree, path);
  return asBlob(
    await get(`/repos/${OWNER}/${REPOSITORY}/git/blobs/${entry.sha}`),
    entry.sha,
  );
}

async function main(): Promise<void> {
  await get(`/repos/${OWNER}/${REPOSITORY}`);
  const ref = (await get(
    `/repos/${OWNER}/${REPOSITORY}/git/ref/heads/main`,
  )) as {
    object?: { sha?: string };
  };
  if (ref.object?.sha !== COMMIT_SHA)
    throw new Error("Pinned commit is not the recorded ref");
  const commit = (await get(
    `/repos/${OWNER}/${REPOSITORY}/git/commits/${COMMIT_SHA}`,
  )) as { sha?: string; tree?: { sha?: string } };
  if (commit.sha !== COMMIT_SHA || commit.tree?.sha === undefined) {
    throw new Error("Pinned commit response mismatch");
  }
  const tree = asTree(
    await get(
      `/repos/${OWNER}/${REPOSITORY}/git/trees/${commit.tree.sha}?recursive=1`,
    ),
  );
  const manifestBlob = await recordBlob(tree, ".claude-plugin/plugin.json");
  const manifest = parseClaudePluginManifest(decode(manifestBlob));
  if (manifest.skillRoots.length !== 25)
    throw new Error("Expected exactly 25 skills");
  await recordBlob(tree, "LICENSE");

  const seenResources = new Set<string>();
  for (const root of manifest.skillRoots) {
    const skillPath = posix.join(root, "SKILL.md");
    const skillBlob = await recordBlob(tree, skillPath);
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(
      decode(skillBlob),
    );
    let resources;
    try {
      resources = extractTextualResourceReferences(markdown, skillPath);
    } catch (error) {
      throw new Error(
        `Resource parser rejected ${skillPath}: ${error instanceof Error ? error.message : "unknown"}`,
        { cause: error },
      );
    }
    for (const resource of resources) {
      seenResources.add(resource.repositoryPath);
    }
  }
  for (const path of [...seenResources].toSorted())
    await recordBlob(tree, path);

  process.stdout.write(
    `${JSON.stringify({
      formatVersion: 1,
      origin: ORIGIN,
      apiVersion: API_VERSION,
      owner: OWNER,
      repository: REPOSITORY,
      commitSha: COMMIT_SHA,
      responses,
    })}\n`,
  );
}

await main();
