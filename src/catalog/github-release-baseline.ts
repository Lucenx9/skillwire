import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  parseAdvisoryChain,
  verifyAdvisoryChain,
} from "../domain/catalog/advisory-chain.js";
import { normalizeUtf8 } from "../domain/catalog/text-normalization.js";
import type { CatalogRelease } from "../domain/catalog/types.js";
import { loadPublishedRevisionHashes } from "./catalog-loader.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const releaseSchema = z
  .object({
    id: z.number().int().positive(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullable(),
    tag_name: z.string().min(1).max(255),
  })
  .loose();

const gitObjectSchema = z
  .object({
    object: z
      .object({
        type: z.string(),
        sha: z.string(),
      })
      .loose(),
  })
  .loose();

const contentSchema = z
  .object({
    encoding: z.literal("base64"),
    content: z.string(),
  })
  .loose();

export interface GitHubBaselineOptions {
  readonly projectRoot: string;
  readonly release: CatalogRelease;
  readonly repository: string;
  readonly token: string;
  readonly apiUrl?: string | undefined;
  readonly fetchImplementation?: typeof fetch | undefined;
}

export interface GitHubBaselineResult {
  readonly mode: "genesis" | "non-genesis";
  readonly selectedGitHubReleaseId: number | null;
  readonly selectedGitHubPublishedAt: string | null;
  readonly resolvedPreviousReleaseCommit: string | null;
}

class GitHubBaselineError extends Error {
  public constructor() {
    super("GitHub advisory baseline verification failed");
    this.name = "GitHubBaselineError";
  }
}

function fail(): never {
  throw new GitHubBaselineError();
}

function validateApiBase(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail();
  }
  const localTestOrigin =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localTestOrigin) return fail();
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

async function readJsonResponse(
  fetchImplementation: typeof fetch,
  url: URL,
  token: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return fail();
  }
  if (!response.ok) return fail();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return fail();
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) return fail();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return fail();
  }
}

async function listPublishedReleases(
  fetchImplementation: typeof fetch,
  apiBase: URL,
  repository: string,
  token: string,
) {
  const releases: z.infer<typeof releaseSchema>[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(
      `${apiBase.pathname}/repos/${repository}/releases`,
      apiBase.origin,
    );
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const value = await readJsonResponse(fetchImplementation, url, token);
    const parsed = z.array(releaseSchema).max(100).safeParse(value);
    if (!parsed.success) return fail();
    for (const release of parsed.data) {
      if (release.draft) continue;
      if (
        release.published_at === null ||
        Number.isNaN(Date.parse(release.published_at))
      ) {
        return fail();
      }
      releases.push(release);
    }
    if (parsed.data.length < 100) return releases;
  }
  return fail();
}

function selectLatestPublished(
  releases: readonly z.infer<typeof releaseSchema>[],
) {
  if (releases.length === 0) return undefined;
  const sorted = releases.toSorted(
    (left, right) =>
      Date.parse(right.published_at ?? "") -
      Date.parse(left.published_at ?? ""),
  );
  const selected = sorted[0];
  if (selected === undefined) return fail();
  if (
    sorted[1] !== undefined &&
    Date.parse(sorted[1].published_at ?? "") ===
      Date.parse(selected.published_at ?? "")
  ) {
    return fail();
  }
  return selected;
}

async function resolveReleaseCommit(
  fetchImplementation: typeof fetch,
  apiBase: URL,
  repository: string,
  token: string,
  tagName: string,
): Promise<string> {
  const encodedTag = tagName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const referenceUrl = new URL(
    `${apiBase.pathname}/repos/${repository}/git/ref/tags/${encodedTag}`,
    apiBase.origin,
  );
  let parsed = gitObjectSchema.safeParse(
    await readJsonResponse(fetchImplementation, referenceUrl, token),
  );
  if (!parsed.success) return fail();
  const visited = new Set<string>();
  for (let depth = 0; depth < 32; depth += 1) {
    const object = parsed.data.object;
    if (object.type === "commit") {
      if (!COMMIT_PATTERN.test(object.sha)) return fail();
      return object.sha;
    }
    if (object.type !== "tag" || !COMMIT_PATTERN.test(object.sha)) {
      return fail();
    }
    if (visited.has(object.sha)) return fail();
    visited.add(object.sha);
    const tagUrl = new URL(
      `${apiBase.pathname}/repos/${repository}/git/tags/${object.sha}`,
      apiBase.origin,
    );
    parsed = gitObjectSchema.safeParse(
      await readJsonResponse(fetchImplementation, tagUrl, token),
    );
    if (!parsed.success) return fail();
  }
  return fail();
}

async function fetchPreviousAdvisoryChain(
  fetchImplementation: typeof fetch,
  apiBase: URL,
  repository: string,
  token: string,
  commit: string,
): Promise<string> {
  const url = new URL(
    `${apiBase.pathname}/repos/${repository}/contents/catalog/advisories.jsonl`,
    apiBase.origin,
  );
  url.searchParams.set("ref", commit);
  const parsed = contentSchema.safeParse(
    await readJsonResponse(fetchImplementation, url, token),
  );
  if (!parsed.success) return fail();
  const encoded = parsed.data.content.replaceAll("\n", "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return fail();
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, "base64");
  } catch {
    return fail();
  }
  if (decoded.byteLength > MAX_RESPONSE_BYTES) return fail();
  try {
    return normalizeUtf8(decoded, MAX_RESPONSE_BYTES).text;
  } catch {
    return fail();
  }
}

export async function verifyGitHubReleaseBaseline(
  options: GitHubBaselineOptions,
): Promise<GitHubBaselineResult> {
  if (
    !REPOSITORY_PATTERN.test(options.repository) ||
    options.token.length < 1 ||
    options.token.length > 4096
  ) {
    return fail();
  }
  const apiBase = validateApiBase(options.apiUrl ?? "https://api.github.com");
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const releases = await listPublishedReleases(
    fetchImplementation,
    apiBase,
    options.repository,
    options.token,
  );
  const selected = selectLatestPublished(releases);

  if (options.release.genesis) {
    if (
      options.release.previousReleaseCommit !== null ||
      selected !== undefined
    ) {
      return fail();
    }
    return {
      mode: "genesis",
      selectedGitHubReleaseId: null,
      selectedGitHubPublishedAt: null,
      resolvedPreviousReleaseCommit: null,
    };
  }

  if (
    selected === undefined ||
    options.release.previousReleaseCommit === null
  ) {
    return fail();
  }
  const commit = await resolveReleaseCommit(
    fetchImplementation,
    apiBase,
    options.repository,
    options.token,
    selected.tag_name,
  );
  if (commit !== options.release.previousReleaseCommit) return fail();

  const previousSerialized = await fetchPreviousAdvisoryChain(
    fetchImplementation,
    apiBase,
    options.repository,
    options.token,
    commit,
  );
  const currentSerialized = normalizeUtf8(
    readFileSync(join(options.projectRoot, "catalog", "advisories.jsonl")),
    MAX_RESPONSE_BYTES,
  ).text;
  if (!currentSerialized.startsWith(previousSerialized)) return fail();
  try {
    const hashes = loadPublishedRevisionHashes(options.projectRoot);
    verifyAdvisoryChain(parseAdvisoryChain(previousSerialized), hashes);
    verifyAdvisoryChain(
      parseAdvisoryChain(currentSerialized),
      hashes,
      options.release.advisoryChainHead,
    );
  } catch {
    return fail();
  }

  return {
    mode: "non-genesis",
    selectedGitHubReleaseId: selected.id,
    selectedGitHubPublishedAt: selected.published_at,
    resolvedPreviousReleaseCommit: commit,
  };
}
