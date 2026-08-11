import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { z } from "zod";

import {
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
} from "../../src/ingestion/github/rest-client.js";

const FIXTURE_ROOT = join(
  process.cwd(),
  "tests/fixtures/github-ingestion/mattpocock-skills-84fdeffd12f2ee307994d1eb6feb48173b6e0502",
);

const skillSchema = z.object({
  name: z.string(),
  path: z.string(),
  userOnly: z.boolean(),
  resources: z.array(z.string()),
  dependencies: z.array(z.string()).optional(),
});

const inventorySchema = z.object({
  repositoryId: z.number().int().positive(),
  owner: z.string(),
  repository: z.string(),
  sourceOwner: z.string(),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  manifestVersion: z.string(),
  license: z.string(),
  skills: z.array(skillSchema).length(25),
});

const treeEntrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  size: z.number().int().nonnegative().optional(),
});

const treeResponseSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  truncated: z.literal(false),
  tree: z.array(treeEntrySchema),
});

const blobResponseSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  size: z.number().int().nonnegative(),
  encoding: z.literal("base64"),
  content: z.string(),
});

const recordedResponseSchema = z.object({
  method: z.literal("GET"),
  path: z.string().startsWith("/repos/mattpocock/skills"),
  status: z.number().int(),
  etag: z.string().nullable(),
  body: z.unknown(),
});

const recordingSchema = z.object({
  formatVersion: z.literal(1),
  origin: z.literal(GITHUB_API_ORIGIN),
  apiVersion: z.literal(GITHUB_API_VERSION),
  owner: z.literal("mattpocock"),
  repository: z.literal("skills"),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  responses: z.array(recordedResponseSchema),
});

const routeSchema = z.object({
  origin: z.literal(GITHUB_API_ORIGIN),
  apiVersion: z.literal(GITHUB_API_VERSION),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  checksums: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  routes: z.array(z.string()),
  responseFixture: z.string(),
});

export type GitHubFixtureInventory = z.infer<typeof inventorySchema>;

interface FixtureFile {
  readonly path: string;
  readonly content: string;
  readonly sha: string;
  readonly size: number;
}

export interface GitHubFixtureCall {
  readonly method: string;
  readonly url: string;
  readonly apiVersion: string | null;
  readonly accept: string | null;
  readonly authorization: string | null;
  readonly redirect: RequestRedirect;
}

export interface GitHubIngestionFixture {
  readonly fetch: typeof fetch;
  readonly inventory: GitHubFixtureInventory;
  readonly calls: readonly GitHubFixtureCall[];
  readonly files: ReadonlyMap<string, FixtureFile>;
  readonly treeSha: string;
  readonly treeEntryCount: number;
}

export interface GitHubIngestionFixtureOptions {
  readonly failBlobPath?: string | undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function response(
  body: unknown,
  status = 200,
  etag: string | null = null,
): Response {
  const encoded = JSON.stringify(body);
  const headers = new Headers({
    "content-length": String(Buffer.byteLength(encoded, "utf8")),
    "content-type": "application/json",
    "x-github-request-id": "FIXTURE-REQUEST",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4999",
  });
  if (etag !== null) headers.set("etag", etag);
  return new Response(encoded, { status, headers });
}

export async function createGitHubIngestionFixture(
  options: GitHubIngestionFixtureOptions = {},
): Promise<GitHubIngestionFixture> {
  const routesSource = await readFile(
    join(FIXTURE_ROOT, "routes.json"),
    "utf8",
  );
  const routes = routeSchema.parse(JSON.parse(routesSource) as unknown);
  const inventorySource = await readFile(
    join(FIXTURE_ROOT, "expected-inventory.json"),
    "utf8",
  );
  if (
    sha256(inventorySource) !==
    (routes.checksums["expected-inventory.json"] ?? "")
  ) {
    throw new Error("FIXTURE_HASH_MISMATCH");
  }
  const inventory = inventorySchema.parse(
    JSON.parse(inventorySource) as unknown,
  );
  const recordingEncoded = await readFile(
    join(FIXTURE_ROOT, routes.responseFixture),
    "utf8",
  );
  if (
    sha256(recordingEncoded) !==
    (routes.checksums[routes.responseFixture] ?? "")
  ) {
    throw new Error("FIXTURE_HASH_MISMATCH");
  }
  const recording = recordingSchema.parse(
    JSON.parse(
      gunzipSync(Buffer.from(recordingEncoded.trim(), "base64")).toString(
        "utf8",
      ),
    ) as unknown,
  );
  if (
    inventory.commitSha !== routes.commitSha ||
    inventory.commitSha !== recording.commitSha
  ) {
    throw new Error("FIXTURE_INVENTORY_MISMATCH");
  }

  const responseByPath = new Map(
    recording.responses.map((recorded) => [recorded.path, recorded] as const),
  );
  if (responseByPath.size !== recording.responses.length) {
    throw new Error("FIXTURE_DUPLICATE_ROUTE");
  }
  const treeRecorded = recording.responses.find(({ path }) =>
    path.includes("/git/trees/"),
  );
  if (treeRecorded === undefined) throw new Error("FIXTURE_TREE_MISSING");
  const tree = treeResponseSchema.parse(treeRecorded.body);
  const pathsBySha = new Map<string, string[]>();
  for (const entry of tree.tree) {
    const paths = pathsBySha.get(entry.sha) ?? [];
    paths.push(entry.path);
    pathsBySha.set(entry.sha, paths);
  }
  const files = new Map<string, FixtureFile>();
  for (const recorded of recording.responses.filter(({ path }) =>
    path.includes("/git/blobs/"),
  )) {
    const blob = blobResponseSchema.parse(recorded.body);
    const content = Buffer.from(
      blob.content.replaceAll(/\s/g, ""),
      "base64",
    ).toString("utf8");
    if (Buffer.byteLength(content, "utf8") !== blob.size) {
      throw new Error("FIXTURE_BLOB_SIZE_MISMATCH");
    }
    for (const path of pathsBySha.get(blob.sha) ?? []) {
      files.set(path, { path, content, sha: blob.sha, size: blob.size });
    }
  }
  const expectedPaths = inventory.skills.flatMap((skill) => {
    const root = skill.path.replace(/\/SKILL\.md$/, "");
    return [
      skill.path,
      ...skill.resources.map((resource) => `${root}/${resource}`),
    ];
  });
  for (const path of [
    ".claude-plugin/plugin.json",
    "LICENSE",
    ...expectedPaths,
  ]) {
    if (!files.has(path)) throw new Error(`FIXTURE_INVENTORY_MISSING:${path}`);
  }

  const calls: GitHubFixtureCall[] = [];
  const fixtureFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({
      method: request.method,
      url: request.url,
      apiVersion: request.headers.get("x-github-api-version"),
      accept: request.headers.get("accept"),
      authorization: request.headers.get("authorization"),
      redirect: init?.redirect ?? "follow",
    });
    if (
      url.origin !== routes.origin ||
      request.method !== "GET" ||
      init?.redirect !== "manual"
    ) {
      throw new Error("FIXTURE_REQUEST_REJECTED");
    }
    const path = `${url.pathname}${url.search}`;
    const recorded = responseByPath.get(path);
    if (recorded === undefined)
      throw new Error(`UNRECORDED_GITHUB_ROUTE:${path}`);
    const parsedBlob = path.includes("/git/blobs/")
      ? blobResponseSchema.safeParse(recorded.body)
      : undefined;
    if (
      parsedBlob?.success === true &&
      (pathsBySha.get(parsedBlob.data.sha) ?? []).includes(
        options.failBlobPath ?? "",
      )
    ) {
      return Promise.resolve(response({}, 503));
    }
    return Promise.resolve(
      response(recorded.body, recorded.status, recorded.etag),
    );
  };
  return {
    fetch: fixtureFetch,
    inventory,
    calls,
    files,
    treeSha: tree.sha,
    treeEntryCount: tree.tree.length,
  };
}
