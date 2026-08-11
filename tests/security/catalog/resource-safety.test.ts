import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadVerifiedCatalogProvider } from "../../../src/catalog/version-controlled-provider.js";
import { assertSafeResourcePath } from "../../../src/domain/catalog/resource-path.js";
import { normalizeUtf8 } from "../../../src/domain/catalog/text-normalization.js";
import { createPublishedCatalogWithStatus } from "../../helpers/catalog-cli.js";

const resourceRelativePath =
  "catalog/skills/typescript-code-review/1.0.0/references/review-checklist.md";

function publishedWorkspace(): string {
  return createPublishedCatalogWithStatus("unavailable");
}

describe("catalog resource safety", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true });
    }
  });

  it.each([
    "../SKILL.md",
    "references/../../SKILL.md",
    "/etc/passwd",
    "references\\resource.md",
    "references/%2e%2e/SKILL.md",
    "references/%252e%252e/SKILL.md",
    "references/\0resource.md",
  ])("rejects traversal or non-normalized path %s", (path) => {
    expect(() => {
      assertSafeResourcePath(path);
    }).toThrow();
  });

  it("rejects invalid UTF-8, NUL, and oversized text", () => {
    expect(() => normalizeUtf8(Uint8Array.from([0xc3, 0x28]))).toThrow();
    expect(() => normalizeUtf8(Buffer.from("text\0body"))).toThrow();
    expect(() => normalizeUtf8(Buffer.alloc(262_145, 0x61))).toThrow();
  });

  it("rejects a symlinked declared resource", () => {
    const workspace = publishedWorkspace();
    workspaces.push(workspace);
    const resourcePath = join(workspace, resourceRelativePath);
    rmSync(resourcePath);
    symlinkSync("../SKILL.md", resourcePath);

    expect(() =>
      loadVerifiedCatalogProvider(workspace, "launch-catalog-v1"),
    ).toThrow();
  });

  it.each([
    ["hash mismatch", "mutated resource\n"],
    ["oversized content", "x".repeat(262_145)],
    ["binary NUL content", "text\0binary"],
  ])("rejects %s before runtime admission", (_label, content) => {
    const workspace = publishedWorkspace();
    workspaces.push(workspace);
    writeFileSync(join(workspace, resourceRelativePath), content);

    expect(() =>
      loadVerifiedCatalogProvider(workspace, "launch-catalog-v1"),
    ).toThrow();
  });
});
