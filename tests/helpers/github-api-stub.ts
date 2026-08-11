import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface GitHubApiCall {
  readonly path: string;
  readonly authorization: string | null;
}

export function githubFixture(projectRoot: string, name: string): unknown {
  return JSON.parse(
    readFileSync(
      join(projectRoot, "tests", "fixtures", "github-release", name),
      "utf8",
    ),
  ) as unknown;
}

export function createGitHubApiStub(
  routes: Readonly<Record<string, unknown>>,
): { readonly fetch: typeof fetch; readonly calls: GitHubApiCall[] } {
  const calls: GitHubApiCall[] = [];
  const fetchImplementation: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const key = `${url.pathname}${url.search}`;
    calls.push({
      path: key,
      authorization: request.headers.get("authorization"),
    });
    if (!(key in routes)) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "not-found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(routes[key]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch: fetchImplementation, calls };
}
