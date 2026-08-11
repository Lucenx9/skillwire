import { posix } from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";

interface MarkdownNode {
  readonly type: string;
  readonly url?: string | undefined;
  readonly identifier?: string | undefined;
  readonly children?: readonly MarkdownNode[] | undefined;
}

export interface ResourceReference {
  readonly manifestPath: string;
  readonly repositoryPath: string;
  readonly mediaType: "text/markdown" | "text/plain";
}

function safeReference(url: string): boolean {
  return (
    !url.startsWith("/") &&
    !url.includes("\\") &&
    !url.includes("%") &&
    !url.includes("?") &&
    !url.includes("#") &&
    !url.includes(":") &&
    url.normalize("NFC") === url &&
    url
      .split("/")
      .every(
        (segment, index) =>
          segment !== "" &&
          segment !== ".." &&
          (segment !== "." || index === 0),
      ) &&
    /\.(?:md|txt)$/i.test(url)
  );
}

function recordReference(url: string, urls: string[]): void {
  if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(url)) return;
  if (!/\.(?:md|txt)(?:[?#]|$)/i.test(url)) return;
  if (!safeReference(url)) throw new Error("PATH_UNSAFE");
  urls.push(url);
}

export function extractTextualResourceReferences(
  markdown: string,
  skillDocumentPath: string,
  signal?: AbortSignal,
): readonly ResourceReference[] {
  signal?.throwIfAborted();
  const tree = fromMarkdown(markdown) as MarkdownNode;
  const urls: string[] = [];
  const definitions = new Map<string, string>();
  const references: string[] = [];
  let nodes = 0;
  const visit = (node: MarkdownNode, depth: number): void => {
    nodes += 1;
    if (nodes % 64 === 0) signal?.throwIfAborted();
    if (nodes > 20_000 || depth > 64) throw new Error("MARKDOWN_OVERSIZED");
    if (node.type === "link" && node.url !== undefined) {
      recordReference(node.url, urls);
    }
    if (
      node.type === "definition" &&
      node.url !== undefined &&
      node.identifier !== undefined
    ) {
      definitions.set(node.identifier, node.url);
    }
    if (node.type === "linkReference" && node.identifier !== undefined) {
      references.push(node.identifier);
    }
    if (
      node.type === "code" ||
      node.type === "inlineCode" ||
      node.type === "html"
    )
      return;
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(tree, 0);
  signal?.throwIfAborted();
  for (const identifier of references) {
    const url = definitions.get(identifier);
    if (url !== undefined) recordReference(url, urls);
  }
  const root = posix.dirname(skillDocumentPath);
  return [...new Set(urls)]
    .map((url) => {
      const manifestPath = posix.normalize(url);
      const repositoryPath = posix.normalize(posix.join(root, manifestPath));
      if (
        manifestPath.startsWith("../") ||
        manifestPath === ".." ||
        repositoryPath.startsWith("../") ||
        repositoryPath.includes("/../")
      ) {
        throw new Error("PATH_UNSAFE");
      }
      return {
        manifestPath,
        repositoryPath,
        mediaType: /\.md$/i.test(url)
          ? ("text/markdown" as const)
          : ("text/plain" as const),
      };
    })
    .toSorted((left, right) =>
      left.manifestPath.localeCompare(right.manifestPath, "en-US"),
    );
}
