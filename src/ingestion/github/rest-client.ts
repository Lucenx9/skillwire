import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  ConditionalRepositoryResult,
  OperationContext,
} from "../../application/ports/github-source-provider.js";
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
    owner: z.object({ login: z.string().min(1).max(100) }).strip(),
  })
  .strip();
const refSchema = z
  .object({
    object: z.object({ type: z.literal("commit"), sha: shaSchema }).strip(),
  })
  .strip();
const commitSchema = z
  .object({ sha: shaSchema, tree: z.object({ sha: shaSchema }).strip() })
  .strip();
const treeEntrySchema = z
  .object({
    path: z.string().min(1).max(4096),
    mode: z.enum(["100644", "100755", "040000", "120000", "160000"]),
    type: z.enum(["blob", "tree", "commit"]),
    sha: shaSchema,
    size: z.number().int().nonnegative().optional(),
  })
  .strip();
const treeSchema = z
  .object({
    sha: shaSchema,
    truncated: z.boolean(),
    tree: z.array(treeEntrySchema),
  })
  .strip();
const blobSchema = z
  .object({
    sha: shaSchema,
    size: z.number().int().nonnegative(),
    encoding: z.literal("base64"),
    content: z.string(),
  })
  .strip();
const searchItemSchema = z
  .object({
    path: z.string().min(1).max(1024),
    repository: z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        name: z.string().min(1).max(100),
        private: z.boolean(),
        owner: z.object({ login: z.string().min(1).max(100) }).strip(),
      })
      .strip(),
  })
  .strip();
const searchSchema = z
  .object({
    total_count: z.number().int().nonnegative(),
    incomplete_results: z.boolean(),
    items: z.array(searchItemSchema).max(100),
  })
  .strip();

export interface GitHubRestClientOptions {
  readonly token?: string | undefined;
  readonly fetchImplementation?: typeof fetch | undefined;
  readonly maximumResponseBytes?: number | undefined;
  readonly maximumAttempts?: number | undefined;
  readonly maximumRetryDelayMs?: number | undefined;
  readonly sleepImplementation?:
    ((milliseconds: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

export interface GitHubSearchPage {
  readonly items: readonly {
    readonly repositoryId: number;
    readonly owner: string;
    readonly repository: string;
    readonly path: string;
  }[];
  readonly incomplete: boolean;
  readonly totalCount: number;
  readonly etag?: string | undefined;
  readonly link?: string | undefined;
  readonly notModified: boolean;
}

export class GitHubRetryDeferredError extends Error {
  constructor(readonly retryAfterMilliseconds: number) {
    super("GITHUB_RATE_LIMITED");
    this.name = "GitHubRetryDeferredError";
  }
}

function operationSignal(context?: OperationContext): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (context?.signal !== undefined) signals.push(context.signal);
  if (context?.deadline !== undefined) {
    if (context.deadline <= Date.now())
      throw new DOMException("deadline exceeded", "TimeoutError");
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

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

async function boundedBody(
  response: Response,
  limit: number,
  signal?: AbortSignal,
  onBytes?: (length: number) => void,
  oversizedCode = "RESPONSE_OVERSIZED",
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit)
    throw new Error(oversizedCode);
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
      throw new Error(oversizedCode);
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onBytes?.(length);
  return result;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error("GITHUB_SCHEMA_INVALID");
  }
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("GITHUB_SCHEMA_INVALID");
  return parsed.data;
}

export class GitHubRestClient {
  readonly #fetch: typeof fetch;
  readonly #token: string | undefined;
  readonly #maximumResponseBytes: number;
  readonly #maximumAttempts: number;
  readonly #maximumRetryDelayMs: number;
  readonly #sleep: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;

  constructor(options: GitHubRestClientOptions = {}) {
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#token = options.token;
    this.#maximumResponseBytes =
      options.maximumResponseBytes ?? 8 * 1024 * 1024;
    this.#maximumAttempts = options.maximumAttempts ?? 3;
    this.#maximumRetryDelayMs = options.maximumRetryDelayMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#sleep = options.sleepImplementation ?? abortableSleep;
    if (this.#maximumAttempts < 1 || this.#maximumAttempts > 4) {
      throw new Error("INVALID_GITHUB_RETRY_CONFIGURATION");
    }
    if (this.#requestTimeoutMs < 1 || this.#requestTimeoutMs > 120_000) {
      throw new Error("INVALID_GITHUB_REQUEST_TIMEOUT");
    }
  }

  get authorizationScope(): "authenticated" | "anonymous" {
    return this.#token === undefined ? "anonymous" : "authenticated";
  }

  async #request(
    path: string,
    context?: OperationContext,
    conditionalEtag?: string,
  ): Promise<Response> {
    safePath(path);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maximumAttempts; attempt += 1) {
      context?.signal?.throwIfAborted();
      if (context?.deadline !== undefined && context.deadline <= this.#now()) {
        throw new DOMException("deadline exceeded", "TimeoutError");
      }
      const budget = context?.budget;
      if (budget !== undefined) {
        if (budget.requests >= budget.maximumRequests)
          throw new Error("REQUEST_BUDGET_EXCEEDED");
        budget.requests += 1;
      }
      const headers = new Headers({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "SkillWire/0.1.0",
      });
      if (this.#token !== undefined)
        headers.set("Authorization", `Bearer ${this.#token}`);
      if (conditionalEtag !== undefined)
        headers.set("If-None-Match", conditionalEtag);
      const operation = operationSignal(context);
      const requestTimeout = AbortSignal.timeout(this.#requestTimeoutMs);
      const signal =
        operation === undefined
          ? requestTimeout
          : AbortSignal.any([operation, requestTimeout]);
      const init: RequestInit = { method: "GET", headers, redirect: "manual" };
      init.signal = signal;
      let response: Response;
      try {
        response = await this.#fetch(`${GITHUB_API_ORIGIN}${path}`, init);
      } catch (error) {
        if (context?.signal?.aborted === true || error instanceof DOMException)
          throw error;
        lastError = error;
        if (attempt === this.#maximumAttempts) throw normalizeFetchError(error);
        await this.#waitBeforeRetry(undefined, attempt, context);
        continue;
      }
      if (!retryableResponse(response) || attempt === this.#maximumAttempts)
        return response;
      lastError = new Error(`GITHUB_HTTP_${String(response.status)}`);
      await response.body?.cancel();
      await this.#waitBeforeRetry(response, attempt, context);
    }
    throw normalizeFetchError(lastError);
  }

  async #waitBeforeRetry(
    response: Response | undefined,
    attempt: number,
    context?: OperationContext,
  ): Promise<void> {
    const budget = context?.budget;
    if (budget !== undefined) {
      if (budget.retries >= budget.maximumRetries)
        throw new Error("RETRY_BUDGET_EXCEEDED");
      budget.retries += 1;
    }
    const delay = retryDelay(response, attempt, this.#now());
    if (delay > this.#maximumRetryDelayMs) {
      throw new GitHubRetryDeferredError(delay);
    }
    if (
      context?.deadline !== undefined &&
      this.#now() + delay >= context.deadline
    ) {
      throw new GitHubRetryDeferredError(delay);
    }
    await this.#sleep(delay, operationSignal(context));
  }

  #recordResponseBytes(length: number, context?: OperationContext): void {
    const budget = context?.budget;
    if (budget === undefined) return;
    budget.responseBytes += length;
    if (budget.responseBytes > budget.maximumResponseBytes) {
      throw new Error("RESPONSE_BUDGET_EXCEEDED");
    }
  }

  #responseLimit(context?: OperationContext): number {
    const budget = context?.budget;
    if (budget === undefined) return this.#maximumResponseBytes;
    const remaining = budget.maximumResponseBytes - budget.responseBytes;
    if (remaining <= 0) throw new Error("RESPONSE_BUDGET_EXCEEDED");
    return Math.min(this.#maximumResponseBytes, remaining);
  }

  #assertJsonResponse(response: Response): void {
    const mediaType = response.headers.get("content-type");
    if (
      mediaType !== null &&
      !/^application\/json(?:\s*;|$)/iu.test(mediaType) &&
      !/^text\/plain(?:\s*;|$)/iu.test(mediaType)
    ) {
      throw new Error("GITHUB_SCHEMA_INVALID");
    }
  }

  async #json(path: string, context?: OperationContext): Promise<unknown> {
    const response = await this.#request(path, context);
    if (!response.ok) throw githubHttpError(response);
    this.#assertJsonResponse(response);
    return parseJson(
      await boundedBody(
        response,
        this.#responseLimit(context),
        operationSignal(context),
        (length) => {
          this.#recordResponseBytes(length, context);
        },
        context?.budget === undefined
          ? "RESPONSE_OVERSIZED"
          : "RESPONSE_BUDGET_EXCEEDED",
      ),
    );
  }

  async searchCode(
    query: string,
    page: number,
    perPage: number,
    context?: OperationContext,
    etag?: string,
  ): Promise<GitHubSearchPage> {
    if (
      query.length < 1 ||
      query.length > 256 ||
      page < 1 ||
      !Number.isInteger(page) ||
      perPage < 1 ||
      perPage > 100 ||
      !Number.isInteger(perPage)
    ) {
      throw new Error("INVALID_DISCOVERY_QUERY");
    }
    const parameters = new URLSearchParams({
      q: query,
      per_page: String(perPage),
      page: String(page),
    });
    const response = await this.#request(
      `/search/code?${parameters.toString()}`,
      context,
      etag,
    );
    if (response.status === 304) {
      return { items: [], incomplete: false, totalCount: 0, notModified: true };
    }
    if (!response.ok) throw githubHttpError(response);
    this.#assertJsonResponse(response);
    const parsed = parseResponse(
      searchSchema,
      parseJson(
        await boundedBody(
          response,
          this.#responseLimit(context),
          operationSignal(context),
          (length) => {
            this.#recordResponseBytes(length, context);
          },
          context?.budget === undefined
            ? "RESPONSE_OVERSIZED"
            : "RESPONSE_BUDGET_EXCEEDED",
        ),
      ),
    );
    return {
      items: parsed.items
        .filter((item) => !item.repository.private)
        .map((item) => ({
          repositoryId: item.repository.id,
          owner: item.repository.owner.login,
          repository: item.repository.name,
          path: item.path,
        })),
      incomplete: parsed.incomplete_results,
      totalCount: parsed.total_count,
      notModified: false,
      ...(response.headers.get("etag") === null
        ? {}
        : { etag: response.headers.get("etag") ?? undefined }),
      ...(response.headers.get("link") === null
        ? {}
        : { link: response.headers.get("link") ?? undefined }),
    };
  }

  async resolvePublicRepository(
    coordinate: GitHubRepositoryCoordinate,
    context?: OperationContext,
  ): Promise<GitHubRepositoryIdentity> {
    const result = await this.resolvePublicRepositoryConditionally(
      coordinate,
      undefined,
      context,
    );
    if (result.repository === undefined || result.notModified) {
      throw new Error("CACHE_MISS_ON_NOT_MODIFIED");
    }
    return result.repository;
  }

  async resolvePublicRepositoryConditionally(
    coordinate: GitHubRepositoryCoordinate,
    etag: string | undefined,
    context?: OperationContext,
  ): Promise<ConditionalRepositoryResult> {
    assertGitHubCoordinate(coordinate);
    let path = `/repos/${encodeURIComponent(coordinate.owner)}/${encodeURIComponent(coordinate.repository)}`;
    let response = await this.#request(path, context, etag);
    if (response.status === 304) {
      return {
        notModified: true,
        ...(etag === undefined ? {} : { etag }),
      };
    }
    if (response.status === 301) {
      const location = response.headers.get("location");
      if (location === null) throw new Error("REDIRECT_REJECTED");
      const target = new URL(location, GITHUB_API_ORIGIN);
      const coordinateMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(
        target.pathname,
      );
      if (
        target.origin !== GITHUB_API_ORIGIN ||
        target.username !== "" ||
        target.password !== "" ||
        target.search !== "" ||
        target.hash !== "" ||
        coordinateMatch === null
      ) {
        throw new Error("REDIRECT_REJECTED");
      }
      const owner = coordinateMatch[1];
      const repository = coordinateMatch[2];
      if (owner === undefined || repository === undefined)
        throw new Error("REDIRECT_REJECTED");
      const redirected = assertGitHubCoordinate({
        owner: decodeURIComponent(owner),
        repository: decodeURIComponent(repository),
      });
      path = `/repos/${encodeURIComponent(redirected.owner)}/${encodeURIComponent(redirected.repository)}`;
      response = await this.#request(path, context);
      if (response.status >= 300 && response.status < 400)
        throw new Error("REDIRECT_REJECTED");
    }
    if (!response.ok) throw githubHttpError(response);
    this.#assertJsonResponse(response);
    const parsed = parseResponse(
      repositorySchema,
      parseJson(
        await boundedBody(
          response,
          this.#responseLimit(context),
          operationSignal(context),
          (length) => {
            this.#recordResponseBytes(length, context);
          },
          context?.budget === undefined
            ? "RESPONSE_OVERSIZED"
            : "RESPONSE_BUDGET_EXCEEDED",
        ),
      ),
    );
    if (parsed.private) throw new Error("SOURCE_NOT_PUBLIC");
    return {
      repository: {
        repositoryId: parsed.id,
        owner: parsed.owner.login,
        repository: parsed.name,
        defaultBranch: parsed.default_branch,
      },
      notModified: false,
      ...(response.headers.get("etag") === null
        ? {}
        : { etag: response.headers.get("etag") ?? undefined }),
    };
  }

  async resolveDefaultRef(
    repository: GitHubRepositoryIdentity,
    context?: OperationContext,
  ): Promise<string> {
    const value = parseResponse(
      refSchema,
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
    const value = parseResponse(
      commitSchema,
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
    const value = parseResponse(
      treeSchema,
      await this.#json(
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/git/trees/${treeSha}?recursive=1`,
        context,
      ),
    );
    if (value.sha !== treeSha) throw new Error("HASH_MISMATCH");
    if (value.truncated) throw new Error("TREE_TRUNCATED");
    if (value.tree.length > maximumEntries) throw new Error("TREE_OVERSIZED");
    const paths = new Map<string, (typeof value.tree)[number]>();
    const validated = value.tree.map((entry) => {
      const segments = entry.path.split("/");
      const folded = entry.path.normalize("NFKC").toLocaleLowerCase("en-US");
      if (
        entry.path.startsWith("/") ||
        entry.path.includes("\\") ||
        entry.path.includes("%") ||
        entry.path.includes("?") ||
        entry.path.includes("#") ||
        Buffer.byteLength(entry.path, "utf8") > 512 ||
        entry.path.normalize("NFC") !== entry.path ||
        hasAsciiControl(entry.path) ||
        segments.length > 64 ||
        segments.some(
          (segment) =>
            segment === "" ||
            segment === "." ||
            segment === ".." ||
            Buffer.byteLength(segment, "utf8") > 255,
        ) ||
        paths.has(folded)
      ) {
        throw new Error("TREE_AMBIGUOUS");
      }
      if (
        (entry.type === "tree" && entry.mode !== "040000") ||
        (entry.type === "commit" && entry.mode !== "160000") ||
        (entry.type === "blob" &&
          !["100644", "100755", "120000"].includes(entry.mode))
      ) {
        throw new Error("OBJECT_UNSUPPORTED");
      }
      paths.set(folded, entry);
      return { ...entry, mode: entry.mode };
    });
    for (const entry of validated) {
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const parent = segments
          .slice(0, index)
          .join("/")
          .normalize("NFKC")
          .toLocaleLowerCase("en-US");
        const parentEntry = paths.get(parent);
        if (parentEntry !== undefined && parentEntry.type !== "tree") {
          throw new Error("TREE_AMBIGUOUS");
        }
      }
    }
    return validated;
  }

  async readBlob(
    repository: GitHubRepositoryIdentity,
    sha: string,
    expectedSize: number,
    context?: OperationContext,
  ): Promise<Uint8Array> {
    assertGitSha(sha);
    const value = parseResponse(
      blobSchema,
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

function retryableResponse(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("retry-after") !== null ||
        response.headers.get("x-ratelimit-remaining") === "0")) ||
    response.status === 500 ||
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504
  );
}

function githubHttpError(response: Response): Error {
  if (response.status === 429 || response.status === 403) {
    return new Error("GITHUB_RATE_LIMITED");
  }
  if (response.status >= 500) return new Error("GITHUB_TRANSIENT");
  return new Error(`GITHUB_HTTP_${String(response.status)}`);
}

function normalizeFetchError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("GITHUB_"))
    return error;
  return new Error("GITHUB_TRANSIENT");
}

function retryDelay(
  response: Response | undefined,
  attempt: number,
  now: number,
): number {
  const retryAfter = response?.headers.get("retry-after");
  if (
    retryAfter !== null &&
    retryAfter !== undefined &&
    /^\d+$/.test(retryAfter)
  ) {
    return Number(retryAfter) * 1000;
  }
  if (response?.headers.get("x-ratelimit-remaining") === "0") {
    const reset = response.headers.get("x-ratelimit-reset");
    if (reset !== null && /^\d+$/.test(reset)) {
      return Math.max(0, Number(reset) * 1000 - now);
    }
  }
  return 50 * 2 ** (attempt - 1);
}

async function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    function abort(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("aborted", "AbortError"),
      );
    }
    function complete(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    const timeout = setTimeout(complete, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}
