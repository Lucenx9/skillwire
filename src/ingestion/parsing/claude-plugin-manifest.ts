import { posix } from "node:path";

import { z } from "zod";

import { decodeInertText } from "./text-content.js";

const metadataOnlyManifestSchema = z
  .object({
    name: z.string().min(1).max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1).max(2048),
    author: z
      .object({
        name: z.string().min(1).max(200),
        url: z.url().optional(),
      })
      .loose(),
    homepage: z.url().optional(),
    repository: z.url().optional(),
    license: z.string().min(1).max(64),
    keywords: z.array(z.string().min(1).max(80)).max(64).optional(),
  })
  .loose();

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

export type InspectedClaudePluginManifest =
  | { readonly kind: "metadata-only" }
  | {
      readonly kind: "authoritative";
      readonly manifest: ClaudePluginManifest;
    };

function decodeManifest(bytes: Uint8Array): unknown {
  if (bytes.byteLength > 256 * 1024) throw new Error("MANIFEST_OVERSIZED");
  const source = decodeInertText(bytes, "MANIFEST_INVALID");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("MANIFEST_INVALID");
  }
}

function parseAuthoritativeManifest(
  decoded: unknown,
  signal?: AbortSignal,
): ClaudePluginManifest {
  const parsed = manifestSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("MANIFEST_INVALID");
  const value = parsed.data;
  const roots = value.skills.map((entry, index) => {
    if (index % 32 === 0) signal?.throwIfAborted();
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
  const foldedRoots = roots.map((root) =>
    root.normalize("NFKC").toLocaleLowerCase("en-US"),
  );
  if (new Set(foldedRoots).size !== roots.length) {
    throw new Error("MANIFEST_DUPLICATE_SKILL");
  }
  for (const [index, root] of foldedRoots.entries()) {
    if (
      foldedRoots.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          (candidate.startsWith(`${root}/`) ||
            root.startsWith(`${candidate}/`)),
      )
    ) {
      throw new Error("MANIFEST_DUPLICATE_SKILL");
    }
  }
  return {
    name: value.name,
    version: value.version,
    author: value.author.name,
    license: value.license,
    skillRoots: roots,
  };
}

export function inspectClaudePluginManifest(
  bytes: Uint8Array,
  signal?: AbortSignal,
): InspectedClaudePluginManifest {
  signal?.throwIfAborted();
  const decoded = decodeManifest(bytes);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new Error("MANIFEST_INVALID");
  }
  if (!Object.hasOwn(decoded, "skills")) {
    if (!metadataOnlyManifestSchema.safeParse(decoded).success) {
      throw new Error("MANIFEST_INVALID");
    }
    return { kind: "metadata-only" };
  }
  const manifest = parseAuthoritativeManifest(decoded, signal);
  signal?.throwIfAborted();
  return { kind: "authoritative", manifest };
}

export function parseClaudePluginManifest(
  bytes: Uint8Array,
  signal?: AbortSignal,
): ClaudePluginManifest {
  const inspected = inspectClaudePluginManifest(bytes, signal);
  if (inspected.kind !== "authoritative") {
    throw new Error("MANIFEST_INVALID");
  }
  return inspected.manifest;
}
