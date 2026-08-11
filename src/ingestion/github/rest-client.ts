import { createHash } from "node:crypto";

import { z } from "zod";

import type { OperationContext } from "../../application/ports/github-source-provider.js";
import {
  assertGitHubCoordinate,
  assertGitSha,
  type GitHubRepositoryCoordinate,
  type GitHubRepositoryIdentity,
  type GitTreeEntry,
} from "../../domain/external-catalog/types.js";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const repositorySchema = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z.string().min(1).max(100),
    private: z.boolean(),
    default_branch: z.string().min(1).max(255),
    owner: z.object({ login: z.string().min(1).max(100) }).loose(),
  })
  .loose();
const refSchema = z
  .object({
    object: z.object({ type: z.literal("commit"), sha: shaSchema }).loose(),
  })
  .loose();
const commitSchema = z
  .object({ sha: shaSchema, tree: z.object({ sha: shaSchema }).loose() })
  .loose();
const treeEntrySchema = z
  .object({
    path: z.string().min(1).max(1024),
    mode: z.enum(["100644", "100755", "040000", "120000", "160000"]),
    type: z.enum(["blob", "tree", "commit"]),
    sha: shaSchema,
    size: z.number().int().nonnegative().optional(),
  })
  .loose();
const treeSchema = z
  .object({
    sha: shaSchema,
    truncated: z.boolean(),
    tree: z.array(treeEntrySchema),
  })
  .loose();
const blobSchema = z
  .object({
    sha: shaSchema,
    size: z.number().int().nonnegative(),
    encoding: z.literal("base64"),
    content: z.string(),
  })
  .loose();

export interface GitHubRestClientOptions {
  readonly token?: string | undefined;
  readonly fetchImplementation?: typeof fetch | undefined;
  readonly maximumResponseBytes?: number | undefined;
}

function operationSignal(context?: OperationContext): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (context?.signal !== undefined) signals.push(context.signal);
  if (context?.deadline !== undefined) {
    signals.push(
      AbortSignal.timeout(Math.max(1, context.deadline - Date.now())),
    );
  }
  return signals.length === 0
    ? undefined
    : signals.length === 1
      ? signals[0]
      : AbortSignal.any(signals);
}

function safePath(path: string): void {
  let containsControlCharacter = false;
  for (let index = 0; index < path.length; index += 1) {
    if (path.charCodeAt(index) <= 31) containsControlCharacter = true;
  }
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    containsControlCharacter
  ) {
    throw new Error("INVALID_GITHUB_PATH");
  }
}

async function boundedBody(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit)
    throw new Error("RESPONSE_OVERSIZED");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    signal?.throwIfAborted();
    const pending = reader.read();
    const next = await (signal === undefined
      ? pending
      : new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const abort = (): void => {
            void reader.cancel(signal.reason);
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("GITHUB_REQUEST_CANCELLED"),
            );
          };
          signal.addEventListener("abort", abort, { once: true });
          pending.then(
            (value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            },
            (error: unknown) => {
              signal.removeEventListener("abort", abort);
              reject(
                error instanceof Error
                  ? error
                  : new Error("GITHUB_RESPONSE_READ_FAILED"),
              );
            },
          );
          if (signal.aborted) abort();
        }));
    if (next.done) break;
    length += next.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error("RESPONSE_OVERSIZED");
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as unknown;
}

export class GitHubRestClient {
  readonly #fetch: typeof fetch;
  readonly #token: string | undefined;
  readonly #maximumResponseBytes: number;

  constructor(options: GitHubRestClientOptions = {}) {
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#token = options.token;
    this.#maximumResponseBytes =
      options.maximumResponseBytes ?? 8 * 1024 * 1024;
  }

  async #request(path: string, context?: OperationContext): Promise<Response> {
    safePath(path);
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "SkillWire/0.1.0",
    });
    if (this.#token !== undefined)
      headers.set("Authorization", `Bearer ${this.#token}`);
    const signal = operationSignal(context);
    const init: RequestInit = {
      method: "GET",
      headers,
      redirect: "manual",
    };
    if (signal !== undefined) init.signal = signal;
    return this.#fetch(`${GITHUB_API_ORIGIN}${path}`, init);
  }

  async #json(path: string, context?: OperationContext): Promise<unknown> {
    const response = await this.#request(path, context);
    if (!response.ok) throw new Error(`GITHUB_HTTP_${String(response.status)}`);
    return parseJson(
      await boundedBody(
        response,
        this.#maximumResponseBytes,
        operationSignal(context),
      ),
    );
  }

  async resolvePublicRepository(
    coordinate: GitHubRepositoryCoordinate,
    context?: OperationContext,
  ): Promise<GitHubRepositoryIdentity> {
    assertGitHubCoordinate(coordinate);
    let path = `/repos/${encodeURIComponent(coordinate.owner)}/${encodeURIComponent(coordinate.repository)}`;
    let redirectedRepositoryId: number | undefined;
    let response = await this.#request(path, context);
    if (response.status === 301) {
      const location = response.headers.get("location");
      if (location === null) throw new Error("REDIRECT_REJECTED");
      const target = new URL(location, GITHUB_API_ORIGIN);
      const coordinateMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(
        target.pathname,
      );
      const numericMatch = /^\/repositories\/([1-9][0-9]*)$/.exec(
        target.pathname,
      );
      if (
        target.origin !== GITHUB_API_ORIGIN ||
        target.search !== "" ||
        target.hash !== "" ||
        (coordinateMatch === null && numericMatch === null)
      ) {
        throw new Error("REDIRECT_REJECTED");
      }
      if (coordinateMatch !== null) {
        const owner = coordinateMatch[1];
        const repository = coordinateMatch[2];
        if (owner === undefined || repository === undefined)
          throw new Error("REDIRECT_REJECTED");
        const redirected = assertGitHubCoordinate({
          owner: decodeURIComponent(owner),
          repository: decodeURIComponent(repository),
        });
        path = `/repos/${encodeURIComponent(redirected.owner)}/${encodeURIComponent(redirected.repository)}`;
      } else {
        path = target.pathname;
        redirectedRepositoryId = Number(numericMatch?.[1]);
        if (!Number.isSafeInteger(redirectedRepositoryId)) {
          throw new Error("REDIRECT_REJECTED");
        }
      }
      response = await this.#request(path, context);
      if (response.status >= 300 && response.status < 400)
        throw new Error("REDIRECT_REJECTED");
    }
    if (!response.ok) throw new Error(`GITHUB_HTTP_${String(response.status)}`);
    const parsed = repositorySchema.parse(
      parseJson(
        await boundedBody(
          response,
          this.#maximumResponseBytes,
          operationSignal(context),
        ),
      ),
    );
    if (parsed.private) throw new Error("SOURCE_NOT_PUBLIC");
    if (
      redirectedRepositoryId !== undefined &&
      parsed.id !== redirectedRepositoryId
    ) {
      throw new Error("REDIRECT_REJECTED");
    }
    return {
      repositoryId: parsed.id,
      owner: parsed.owner.login,
      repository: parsed.name,
      defaultBranch: parsed.default_branch,
    };
  }

  async resolveDefaultRef(
    repository: GitHubRepositoryIdentity,
    context?: OperationContext,
  ): Promise<string> {
    const value = refSchema.parse(
      await this.#json(
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/git/ref/heads/${encodeURIComponent(repository.defaultBranch)}`,
        context,
      ),
    );
    return value.object.sha;
  }

  async readCommit(
    repository: GitHubRepositoryIdentity,
    commitSha: string,
    context?: OperationContext,
  ): Promise<string> {
    assertGitSha(commitSha);
    const value = commitSchema.parse(
      await this.#json(
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/git/commits/${commitSha}`,
        context,
      ),
    );
    if (value.sha !== commitSha) throw new Error("COMMIT_MISMATCH");
    return value.tree.sha;
  }

  async readTree(
    repository: GitHubRepositoryIdentity,
    treeSha: string,
    maximumEntries: number,
    context?: OperationContext,
  ): Promise<readonly GitTreeEntry[]> {
    assertGitSha(treeSha);
    const value = treeSchema.parse(
      await this.#json(
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/git/trees/${treeSha}?recursive=1`,
        context,
      ),
    );
    if (value.sha !== treeSha) throw new Error("HASH_MISMATCH");
    if (value.truncated) throw new Error("TREE_TRUNCATED");
    if (value.tree.length > maximumEntries) throw new Error("TREE_OVERSIZED");
    const paths = new Set<string>();
    return value.tree.map((entry) => {
      if (
        entry.path.startsWith("/") ||
        entry.path.includes("\\") ||
        entry.path
          .split("/")
          .some(
            (segment) => segment === "" || segment === "." || segment === "..",
          ) ||
        entry.path.normalize("NFC") !== entry.path ||
        paths.has(entry.path.toLowerCase())
      ) {
        throw new Error("TREE_AMBIGUOUS");
      }
      paths.add(entry.path.toLowerCase());
      return { ...entry, mode: entry.mode };
    });
  }

  async readBlob(
    repository: GitHubRepositoryIdentity,
    sha: string,
    expectedSize: number,
    context?: OperationContext,
  ): Promise<Uint8Array> {
    assertGitSha(sha);
    const value = blobSchema.parse(
      await this.#json(
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/git/blobs/${sha}`,
        context,
      ),
    );
    if (value.sha !== sha || value.size !== expectedSize)
      throw new Error("HASH_MISMATCH");
    const encoded = value.content.replaceAll(/\s/g, "");
    if (
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    ) {
      throw new Error("HASH_MISMATCH");
    }
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.byteLength !== expectedSize) throw new Error("HASH_MISMATCH");
    const objectSha = createHash("sha1")
      .update(`blob ${String(decoded.byteLength)}\0`)
      .update(decoded)
      .digest("hex");
    if (objectSha !== sha) throw new Error("HASH_MISMATCH");
    return Uint8Array.from(decoded);
  }
}
