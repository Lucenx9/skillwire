import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import type { GitTreeEntry } from "../src/domain/external-catalog/types.js";
import { discoverNestedSkillDocuments } from "../src/ingestion/parsing/nested-skill-layout.js";
import { inspectClaudePluginManifest } from "../src/ingestion/parsing/claude-plugin-manifest.js";
import { parseSkillDocument } from "../src/ingestion/parsing/frontmatter.js";
import { extractTextualResourceReferences } from "../src/ingestion/parsing/markdown-resources.js";

const ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";
const OWNER = "obra";
const REPOSITORY = "superpowers";
const COMMIT_SHA = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";
const TREE_SHA = "21219529a4e224bcb27baf8816b039c8bf7c6673";
const FIXTURE_ROOT = join(
  process.cwd(),
  "tests/fixtures/github-ingestion/obra-superpowers-b36e0829c6d0140e93cfef2ca599b1b07d4a7797",
);
const RESPONSE_FIXTURE = "responses/recording.json.gz.b64";

interface RecordedResponse {
  readonly method: "GET";
  readonly path: string;
  readonly status: number;
  readonly etag: string | null;
  readonly body: unknown;
}

interface TreeResponse {
  readonly sha: string;
  readonly truncated: boolean;
  readonly tree: readonly GitTreeEntry[];
}

interface BlobResponse {
  readonly sha: string;
  readonly size: number;
  readonly encoding: "base64";
  readonly content: string;
}

const responses: RecordedResponse[] = [];

async function get(path: string): Promise<unknown> {
  if (!path.startsWith(`/repos/${OWNER}/${REPOSITORY}`)) {
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
  if (!response.ok) {
    throw new Error(
      `GitHub fixture request failed: ${String(response.status)}`,
    );
  }
  return body;
}

function asTree(value: unknown): TreeResponse {
  const tree = value as TreeResponse;
  if (tree.truncated || tree.sha !== TREE_SHA || !Array.isArray(tree.tree)) {
    throw new Error("Invalid, unexpected, or truncated fixture tree");
  }
  return tree;
}

function regularBlob(tree: TreeResponse, path: string): GitTreeEntry {
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
  if (bytes.byteLength !== blob.size) {
    throw new Error("Fixture blob size mismatch");
  }
  return bytes;
}

async function recordBlob(
  tree: TreeResponse,
  path: string,
): Promise<BlobResponse> {
  const entry = regularBlob(tree, path);
  const blob = (await get(
    `/repos/${OWNER}/${REPOSITORY}/git/blobs/${entry.sha}`,
  )) as BlobResponse;
  if (blob.sha !== entry.sha) throw new Error("Fixture blob mismatch");
  return blob;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function wrapBase64(value: string): string {
  return `${value.match(/.{1,76}/g)?.join("\n") ?? ""}\n`;
}

async function main(): Promise<void> {
  await get(`/repos/${OWNER}/${REPOSITORY}`);
  const ref = (await get(
    `/repos/${OWNER}/${REPOSITORY}/git/ref/heads/main`,
  )) as { object?: { sha?: string } };
  if (ref.object?.sha !== COMMIT_SHA) {
    throw new Error("Pinned commit is not the recorded ref");
  }
  const commit = (await get(
    `/repos/${OWNER}/${REPOSITORY}/git/commits/${COMMIT_SHA}`,
  )) as { sha?: string; tree?: { sha?: string } };
  if (commit.sha !== COMMIT_SHA || commit.tree?.sha !== TREE_SHA) {
    throw new Error("Pinned commit response mismatch");
  }
  const tree = asTree(
    await get(
      `/repos/${OWNER}/${REPOSITORY}/git/trees/${TREE_SHA}?recursive=1`,
    ),
  );
  const manifest = inspectClaudePluginManifest(
    decode(await recordBlob(tree, ".claude-plugin/plugin.json")),
  );
  if (manifest.kind !== "metadata-only") {
    throw new Error("Expected plugin-only metadata");
  }
  await recordBlob(tree, "LICENSE");

  const skills = discoverNestedSkillDocuments(tree.tree, {
    maximumCandidates: 256,
  });
  if (skills.length !== 14) throw new Error("Expected exactly 14 skills");
  const resourcePaths = new Set<string>();
  for (const entry of skills) {
    const source = decode(await recordBlob(tree, entry.path));
    const document = parseSkillDocument(source);
    try {
      for (const resource of extractTextualResourceReferences(
        document.instructions,
        entry.path,
      )) {
        resourcePaths.add(resource.repositoryPath);
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "PATH_UNSAFE") {
        throw error;
      }
    }
  }
  for (const path of [...resourcePaths].toSorted()) {
    await recordBlob(tree, path);
  }

  const recording = `${JSON.stringify({
    formatVersion: 1,
    origin: ORIGIN,
    apiVersion: API_VERSION,
    owner: OWNER,
    repository: REPOSITORY,
    commitSha: COMMIT_SHA,
    responses,
  })}\n`;
  const encoded = wrapBase64(
    gzipSync(recording, { level: 9 }).toString("base64"),
  );
  const inventoryPath = join(FIXTURE_ROOT, "expected-inventory.json");
  const inventory = readFileSync(inventoryPath, "utf8");
  const routes = {
    origin: ORIGIN,
    apiVersion: API_VERSION,
    commitSha: COMMIT_SHA,
    checksums: {
      "expected-inventory.json": sha256(inventory),
      [RESPONSE_FIXTURE]: sha256(encoded),
    },
    routes: responses.map(({ path }) => path),
    responseFixture: RESPONSE_FIXTURE,
  };
  mkdirSync(join(FIXTURE_ROOT, "responses"), { recursive: true });
  writeFileSync(join(FIXTURE_ROOT, RESPONSE_FIXTURE), encoded, {
    encoding: "utf8",
    mode: 0o644,
  });
  writeFileSync(
    join(FIXTURE_ROOT, "routes.json"),
    `${JSON.stringify(routes, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
  process.stdout.write(
    `${JSON.stringify({
      commitSha: COMMIT_SHA,
      treeSha: TREE_SHA,
      skillCount: skills.length,
      resourceCount: resourcePaths.size,
      responseCount: responses.length,
      recordingSha256: routes.checksums[RESPONSE_FIXTURE],
    })}\n`,
  );
}

await main();
