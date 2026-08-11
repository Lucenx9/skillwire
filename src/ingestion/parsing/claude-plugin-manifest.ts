import { posix } from "node:path";

import { z } from "zod";

const manifestSchema = z
  .object({
    name: z.string().min(1).max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1).max(2048),
    author: z
      .object({
        name: z.string().min(1).max(200),
        url: z.url().optional(),
      })
      .strict(),
    homepage: z.url().optional(),
    repository: z.url().optional(),
    license: z.string().min(1).max(64),
    keywords: z.array(z.string().min(1).max(80)).max(64).optional(),
    skills: z.array(z.string().min(1).max(512)).min(1).max(256),
  })
  .strict();

export interface ClaudePluginManifest {
  readonly name: string;
  readonly version: string;
  readonly author: string;
  readonly license: string;
  readonly skillRoots: readonly string[];
}

export function parseClaudePluginManifest(
  bytes: Uint8Array,
): ClaudePluginManifest {
  if (bytes.byteLength > 256 * 1024) throw new Error("MANIFEST_OVERSIZED");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = manifestSchema.parse(JSON.parse(source) as unknown);
  const roots = value.skills.map((entry) => {
    if (
      !entry.startsWith("./") ||
      entry.includes("\\") ||
      entry.includes(":") ||
      entry.includes("%") ||
      entry.normalize("NFC") !== entry ||
      entry
        .slice(2)
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        )
    ) {
      throw new Error("PATH_UNSAFE");
    }
    const normalized = posix.normalize(entry.slice(2));
    if (
      normalized.startsWith("../") ||
      normalized === "." ||
      normalized === ".."
    ) {
      throw new Error("PATH_UNSAFE");
    }
    return normalized;
  });
  if (new Set(roots.map((root) => root.toLowerCase())).size !== roots.length) {
    throw new Error("MANIFEST_DUPLICATE_SKILL");
  }
  return {
    name: value.name,
    version: value.version,
    author: value.author.name,
    license: value.license,
    skillRoots: roots,
  };
}
