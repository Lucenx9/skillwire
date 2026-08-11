import { z } from "zod";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parseDocument } from "yaml";

import type {
  ExternalDependencyInput,
  InvocationMode,
} from "../../domain/external-catalog/types.js";

const metadataSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(120),
    description: z.string().min(1).max(1024),
    "disable-model-invocation": z.boolean().optional(),
    "argument-hint": z.string().min(1).max(1024).optional(),
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

function dependencies(body: string): readonly ExternalDependencyInput[] {
  interface Node {
    readonly type: string;
    readonly value?: string | undefined;
    readonly children?: readonly Node[] | undefined;
  }
  const searchable: string[] = [];
  let nodes = 0;
  const visit = (node: Node, depth: number): void => {
    nodes += 1;
    if (nodes > 20_000 || depth > 64) throw new Error("SKILL_SCHEMA_INVALID");
    if (node.type === "code" || node.type === "html") return;
    if (
      (node.type === "text" || node.type === "inlineCode") &&
      node.value !== undefined
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

export function parseSkillDocument(bytes: Uint8Array): ParsedSkillDocument {
  if (bytes.byteLength > 256 * 1024) throw new Error("SKILL_OVERSIZED");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.includes("\u0000")) throw new Error("SKILL_NON_TEXT");
  const parts = splitFrontmatter(source);
  if (/[&*!][A-Za-z0-9_-]+|<<\s*:|%(?:YAML|TAG)/.test(parts.yaml)) {
    throw new Error("SKILL_SCHEMA_INVALID");
  }
  const document = parseDocument(parts.yaml, {
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error("SKILL_SCHEMA_INVALID");
  }
  const metadata = metadataSchema.parse(document.toJS({ maxAliasCount: 0 }));
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
      ...dependencies(parts.body),
    ].filter(
      (entry, index, values) =>
        values.findIndex(({ skillName }) => skillName === entry.skillName) ===
        index,
    ),
  };
}
