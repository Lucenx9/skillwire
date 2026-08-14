import { sha256Hex } from "../../domain/catalog/canonical-revision.js";
import {
  assertGitHubCoordinate,
  type DiscoveryBudgets,
  type DiscoveryEvidenceKind,
  type GitHubDiscoveryEvidence,
  type GitHubDiscoveryHint,
} from "../../domain/external-catalog/types.js";
import type {
  GitHubOperationBudget,
  OperationContext,
} from "../../application/ports/github-source-provider.js";
import {
  GITHUB_API_ORIGIN,
  type GitHubSearchPage,
  type GitHubRestClient,
} from "./rest-client.js";

export interface DiscoveryQuery {
  readonly query: string;
  readonly evidenceKind: DiscoveryEvidenceKind;
}

export interface GitHubDiscoveryConfiguration extends DiscoveryBudgets {
  readonly querySetId: string;
  readonly queries: readonly DiscoveryQuery[];
}

export interface DiscoveryPageCacheEntry {
  readonly etag: string;
  readonly bodySha256: string;
  readonly page: GitHubSearchPage;
}

export interface DiscoveryPageCache {
  get(
    key: string,
    context?: OperationContext,
  ): Promise<DiscoveryPageCacheEntry | undefined>;
  put(
    key: string,
    entry: DiscoveryPageCacheEntry,
    context?: OperationContext,
  ): Promise<void>;
}

export interface GitHubDiscoveryResult {
  readonly querySetId: string;
  readonly hints: readonly GitHubDiscoveryHint[];
  readonly evidence: readonly GitHubDiscoveryEvidence[];
  readonly incomplete: boolean;
  readonly counters: {
    readonly queries: number;
    readonly pages: number;
    readonly results: number;
    readonly uniqueRepositories: number;
    readonly requests: number;
    readonly retries: number;
    readonly responseBytes: number;
  };
}

class MemoryDiscoveryPageCache implements DiscoveryPageCache {
  readonly #entries = new Map<string, DiscoveryPageCacheEntry>();

  get(key: string): Promise<DiscoveryPageCacheEntry | undefined> {
    return Promise.resolve(this.#entries.get(key));
  }

  put(key: string, entry: DiscoveryPageCacheEntry): Promise<void> {
    this.#entries.set(key, entry);
    return Promise.resolve();
  }
}

export class GitHubSearchDiscoveryProvider {
  readonly #cache: DiscoveryPageCache;

  constructor(
    private readonly client: GitHubRestClient,
    private readonly configuration: GitHubDiscoveryConfiguration,
    cache?: DiscoveryPageCache,
  ) {
    validateConfiguration(configuration);
    this.#cache = cache ?? new MemoryDiscoveryPageCache();
  }

  async discover(
    context: OperationContext = {},
  ): Promise<GitHubDiscoveryResult> {
    const budget: GitHubOperationBudget =
      context.budget !== undefined &&
      context.budget.maximumRequests <= this.configuration.maximumRequests &&
      context.budget.maximumResponseBytes <=
        this.configuration.maximumResponseBytes
        ? context.budget
        : {
            requests: context.budget?.requests ?? 0,
            retries: context.budget?.retries ?? 0,
            responseBytes: context.budget?.responseBytes ?? 0,
            maximumRequests: Math.min(
              context.budget?.maximumRequests ?? Number.MAX_SAFE_INTEGER,
              this.configuration.maximumRequests,
            ),
            maximumRetries: context.budget?.maximumRetries ?? 3,
            maximumResponseBytes: Math.min(
              context.budget?.maximumResponseBytes ?? Number.MAX_SAFE_INTEGER,
              this.configuration.maximumResponseBytes,
            ),
          };
    const operation: OperationContext = {
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
      budget,
    };
    const hints = new Map<number, GitHubDiscoveryHint>();
    const evidence = new Map<string, GitHubDiscoveryEvidence>();
    let pages = 0;
    let resultCount = 0;
    let incomplete = false;
    for (const query of this.configuration.queries) {
      for (
        let pageNumber = 1;
        pageNumber <= this.configuration.maximumPagesPerQuery;
        pageNumber += 1
      ) {
        context.signal?.throwIfAborted();
        const cacheKey = `${this.client.authorizationScope}:${this.configuration.querySetId}:${sha256Hex(query.query)}:${String(pageNumber)}:${String(this.configuration.resultsPerPage)}`;
        const cached = await this.#cache.get(cacheKey, operation);
        let page = await this.client.searchCode(
          query.query,
          pageNumber,
          this.configuration.resultsPerPage,
          operation,
          cached?.etag,
        );
        if (page.notModified) {
          const cachedPage = cached?.page;
          if (
            cachedPage === undefined ||
            cached?.bodySha256 !== hashPage(cachedPage)
          ) {
            throw new Error("CACHE_MISS_ON_NOT_MODIFIED");
          }
          page = cachedPage;
        } else if (page.etag !== undefined) {
          await this.#cache.put(
            cacheKey,
            {
              etag: page.etag,
              bodySha256: hashPage(page),
              page,
            },
            operation,
          );
        }
        pages += 1;
        resultCount += page.items.length;
        if (resultCount > this.configuration.maximumResults) {
          throw new Error("RESULT_BUDGET_EXCEEDED");
        }
        incomplete ||= page.incomplete;
        for (const item of page.items) {
          assertGitHubCoordinate(item);
          hints.set(item.repositoryId, {
            repositoryId: item.repositoryId,
            owner: item.owner,
            repository: item.repository,
          });
          const basename =
            query.evidenceKind === "claude-plugin-manifest"
              ? "plugin.json"
              : "SKILL.md";
          const pathHash = sha256Hex(item.path.normalize("NFC"));
          evidence.set(
            `${String(item.repositoryId)}:${query.evidenceKind}:${pathHash}`,
            {
              repositoryId: item.repositoryId,
              kind: query.evidenceKind,
              pathHash,
              basename,
            },
          );
        }
        const hasNext = validateNextLink(
          page.link,
          query.query,
          pageNumber,
          this.configuration.resultsPerPage,
        );
        if (!hasNext) break;
        if (pageNumber === this.configuration.maximumPagesPerQuery) {
          throw new Error("PAGINATION_BUDGET_EXCEEDED");
        }
      }
    }
    return {
      querySetId: this.configuration.querySetId,
      hints: [...hints.values()].toSorted(
        (a, b) => a.repositoryId - b.repositoryId,
      ),
      evidence: [...evidence.values()].toSorted((a, b) => {
        const repository = a.repositoryId - b.repositoryId;
        return repository === 0
          ? a.pathHash.localeCompare(b.pathHash, "en-US")
          : repository;
      }),
      incomplete,
      counters: {
        queries: this.configuration.queries.length,
        pages,
        results: resultCount,
        uniqueRepositories: hints.size,
        requests: budget.requests,
        retries: budget.retries,
        responseBytes: budget.responseBytes,
      },
    };
  }
}

function validateConfiguration(
  configuration: GitHubDiscoveryConfiguration,
): void {
  if (
    configuration.queries.length < 1 ||
    configuration.queries.length > configuration.maximumQueries ||
    configuration.maximumQueries < 1 ||
    configuration.maximumQueries > 16 ||
    configuration.maximumPagesPerQuery < 1 ||
    configuration.maximumPagesPerQuery > 10 ||
    configuration.resultsPerPage < 1 ||
    configuration.resultsPerPage > 100 ||
    configuration.maximumResults < 1 ||
    configuration.maximumRequests < 1 ||
    configuration.maximumResponseBytes < 1
  ) {
    throw new Error("INVALID_DISCOVERY_CONFIGURATION");
  }
  for (const query of configuration.queries) {
    if (query.query.length < 1 || query.query.length > 256) {
      throw new Error("INVALID_DISCOVERY_CONFIGURATION");
    }
  }
}

function validateNextLink(
  link: string | undefined,
  query: string,
  currentPage: number,
  perPage: number,
): boolean {
  if (link === undefined) return false;
  const next = link
    .split(",")
    .map((value) => /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(value))
    .find((match) => match?.[2] === "next");
  if (next?.[1] === undefined) return false;
  const target = new URL(next[1]);
  if (
    target.origin !== GITHUB_API_ORIGIN ||
    target.username !== "" ||
    target.password !== "" ||
    target.pathname !== "/search/code" ||
    target.hash !== "" ||
    target.searchParams.size !== 3 ||
    target.searchParams.get("q") !== query ||
    target.searchParams.get("per_page") !== String(perPage) ||
    target.searchParams.get("page") !== String(currentPage + 1)
  ) {
    throw new Error("PAGINATION_INVALID");
  }
  return true;
}

function hashPage(page: GitHubSearchPage): string {
  return sha256Hex(
    JSON.stringify({
      items: page.items.map((item) => ({
        repositoryId: item.repositoryId,
        owner: item.owner,
        repository: item.repository,
        path: item.path,
      })),
      incomplete: page.incomplete,
      totalCount: page.totalCount,
      link: page.link ?? null,
    }),
  );
}
