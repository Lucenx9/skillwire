import { z } from "zod";
import { fromMarkdown } from "mdast-util-from-markdown";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import type {
  ExternalDependencyInput,
  InvocationMode,
} from "../../domain/external-catalog/types.js";
import { decodeInertText } from "./text-content.js";

const metadataSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(120),
    description: z.string().min(1).max(1024),
    "disable-model-invocation": z.boolean().optional(),
    "argument-hint": z.string().min(1).max(1024).optional(),
    license: z.string().min(1).max(64).optional(),
    dependencies: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(120),
      )
      .max(32)
      .optional(),
  })
  .strict();

export interface ParsedSkillDocument {
  readonly name: string;
  readonly description: string;
  readonly invocationMode: InvocationMode;
  readonly instructions: string;
  readonly dependencyEvidence: readonly ExternalDependencyInput[];
  readonly declaredSpdxId?: string | undefined;
}

function splitFrontmatter(source: string): {
  readonly yaml: string;
  readonly body: string;
} {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new Error("SKILL_SCHEMA_INVALID");
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1 || end > 16 * 1024) throw new Error("SKILL_SCHEMA_INVALID");
  return { yaml: normalized.slice(4, end), body: normalized.slice(end + 5) };
}

function validateYamlStructure(node: unknown, signal?: AbortSignal): void {
  const state = { nodes: 0, keys: 0 };
  const visit = (value: unknown, depth: number): void => {
    state.nodes += 1;
    if (state.nodes % 64 === 0) signal?.throwIfAborted();
    if (state.nodes > 2048 || depth > 32) {
      throw new Error("SKILL_SCHEMA_INVALID");
    }
    if (value !== null && typeof value === "object") {
      const decorated = value as {
        readonly anchor?: unknown;
        readonly tag?: unknown;
      };
      if (decorated.anchor !== undefined || decorated.tag !== undefined) {
        throw new Error("SKILL_SCHEMA_INVALID");
      }
    }
    if (isMap(value)) {
      state.keys += value.items.length;
      if (state.keys > 128) throw new Error("SKILL_SCHEMA_INVALID");
      for (const pair of value.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          throw new Error("SKILL_SCHEMA_INVALID");
        }
        if (
          ["__proto__", "prototype", "constructor"].includes(pair.key.value)
        ) {
          throw new Error("SKILL_SCHEMA_INVALID");
        }
        if (Buffer.byteLength(pair.key.value, "utf8") > 1024) {
          throw new Error("SKILL_SCHEMA_INVALID");
        }
        visit(pair.value, depth + 1);
      }
      return;
    }
    if (isSeq(value)) {
      for (const item of value.items) visit(item, depth + 1);
      return;
    }
    if (isScalar(value)) {
      if (
        typeof value.value === "string" &&
        Buffer.byteLength(value.value, "utf8") > 16 * 1024
      ) {
        throw new Error("SKILL_SCHEMA_INVALID");
      }
      return;
    }
    if (value !== null) throw new Error("SKILL_SCHEMA_INVALID");
  };
  visit(node, 0);
}

function dependencies(
  body: string,
  signal?: AbortSignal,
): readonly ExternalDependencyInput[] {
  interface Node {
    readonly type: string;
    readonly value?: string | undefined;
    readonly children?: readonly Node[] | undefined;
  }
  const searchable: string[] = [];
  let nodes = 0;
  const visit = (node: Node, depth: number): void => {
    nodes += 1;
    if (nodes % 64 === 0) signal?.throwIfAborted();
    if (nodes > 20_000 || depth > 64) throw new Error("SKILL_SCHEMA_INVALID");
    if (node.type === "code" || node.type === "html") return;
    if (node.type === "text" && node.value !== undefined) {
      searchable.push(node.value);
    }
    if (
      node.type === "inlineCode" &&
      node.value !== undefined &&
      /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(node.value)
    ) {
      searchable.push(node.value);
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(fromMarkdown(body), 0);
  const matches = searchable.flatMap((value) => [
    ...value.matchAll(/(?:^|[\s(])\/([a-z0-9]+(?:-[a-z0-9]+)*)\b/g),
  ]);
  return [
    ...new Set(
      matches
        .map((match) => match[1])
        .filter((name): name is string => name !== undefined),
    ),
  ]
    .toSorted()
    .map((skillName) => ({
      skillName,
      required: true,
      evidenceKind: "explicit-invocation" as const,
      evidenceLocator: `instructions:${String(body.indexOf(`/${skillName}`))}`,
    }));
}

export function parseSkillDocument(
  bytes: Uint8Array,
  signal?: AbortSignal,
): ParsedSkillDocument {
  signal?.throwIfAborted();
  if (bytes.byteLength > 256 * 1024) throw new Error("SKILL_OVERSIZED");
  const source = decodeInertText(bytes, "SKILL_NON_TEXT");
  const parts = splitFrontmatter(source);
  if (/[&*!][A-Za-z0-9_-]+|<<\s*:|%(?:YAML|TAG)/.test(parts.yaml)) {
    throw new Error("SKILL_SCHEMA_INVALID");
  }
  let document;
  try {
    document = parseDocument(parts.yaml, {
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    });
  } catch {
    throw new Error("SKILL_SCHEMA_INVALID");
  }
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error("SKILL_SCHEMA_INVALID");
  }
  validateYamlStructure(document.contents, signal);
  let metadataSource: unknown;
  try {
    metadataSource = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error("SKILL_SCHEMA_INVALID");
  }
  const parsedMetadata = metadataSchema.safeParse(metadataSource);
  if (!parsedMetadata.success) throw new Error("SKILL_SCHEMA_INVALID");
  const metadata = parsedMetadata.data;
  if (Buffer.byteLength(parts.body, "utf8") > 256 * 1024)
    throw new Error("SKILL_OVERSIZED");
  return {
    name: metadata.name,
    description: metadata.description,
    invocationMode:
      metadata["disable-model-invocation"] === true ? "user-only" : "automatic",
    instructions: parts.body.normalize("NFC"),
    dependencyEvidence: [
      ...(metadata.dependencies ?? []).map((skillName, index) => ({
        skillName,
        required: true,
        evidenceKind: "frontmatter" as const,
        evidenceLocator: `frontmatter:dependencies:${String(index)}`,
      })),
      ...dependencies(parts.body, signal),
    ].filter(
      (entry, index, values) =>
        values.findIndex(({ skillName }) => skillName === entry.skillName) ===
        index,
    ),
    ...(metadata.license === undefined
      ? {}
      : { declaredSpdxId: metadata.license }),
  };
}
