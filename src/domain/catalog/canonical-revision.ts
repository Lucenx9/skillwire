import { createHash } from "node:crypto";

import { assertSafeResourcePath } from "./resource-path.js";
import { normalizeUtf8 } from "./text-normalization.js";
import type {
  PublishedProvenance,
  SkillRevision,
  TextMediaType,
  VerifiedResource,
} from "./types.js";

const MAX_RESOURCES = 64;
const MAX_BUNDLE_CONTENT_BYTES = 2 * 1024 * 1024;

export interface RevisionResourceInput {
  readonly path: string;
  readonly mediaType: TextMediaType;
  readonly content: string;
}

export interface CreateSkillRevisionInput {
  readonly skillId: string;
  readonly revision: string;
  readonly publishedProvenance: PublishedProvenance;
  readonly instructions: string;
  readonly resources: readonly RevisionResourceInput[];
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Canonical numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  if (typeof value !== "object")
    throw new Error("Value is not canonical JSON data");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => {
      const entry = record[key];
      if (entry === undefined)
        throw new Error("Canonical JSON does not allow undefined");
      return `${JSON.stringify(key)}:${canonicalize(entry)}`;
    })
    .join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPayload(revision: SkillRevision): unknown {
  return {
    schemaVersion: 1,
    skillId: revision.skillId,
    revision: revision.revision,
    publishedProvenance: revision.publishedProvenance,
    instructions: revision.instructions,
    resourceManifest: revision.resourceManifest,
    resources: revision.resources.map((resource) => ({
      path: resource.path,
      content: resource.content,
    })),
  };
}

export function canonicalizeRevision(revision: SkillRevision): string {
  return canonicalJson(canonicalPayload(revision));
}

export function createSkillRevision(
  input: CreateSkillRevisionInput,
): SkillRevision {
  if (input.resources.length === 0 || input.resources.length > MAX_RESOURCES) {
    throw new Error("Revision must declare between one and 64 resources");
  }

  const normalizedInstructions = normalizeUtf8(
    Buffer.from(input.instructions, "utf8"),
  );
  const resources: VerifiedResource[] = input.resources
    .map((resource) => {
      assertSafeResourcePath(resource.path);
      const normalized = normalizeUtf8(Buffer.from(resource.content, "utf8"));
      return {
        path: resource.path,
        mediaType: resource.mediaType,
        byteLength: normalized.byteLength,
        sha256: sha256Hex(normalized.text),
        content: normalized.text,
      };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path, "en-US"));

  if (
    new Set(resources.map((resource) => resource.path)).size !==
    resources.length
  ) {
    throw new Error("Resource paths must be unique");
  }
  const totalBytes =
    normalizedInstructions.byteLength +
    resources.reduce((total, resource) => total + resource.byteLength, 0);
  if (totalBytes > MAX_BUNDLE_CONTENT_BYTES)
    throw new Error("Revision content exceeds bundle size");

  const withoutBundleHash: SkillRevision = {
    skillId: input.skillId,
    revision: input.revision,
    publishedProvenance: input.publishedProvenance,
    instructions: normalizedInstructions.text,
    instructionsSha256: sha256Hex(normalizedInstructions.text),
    resourceManifest: resources.map(
      ({ content: _content, ...manifest }) => manifest,
    ),
    resources,
    bundleSha256: "",
  };
  return {
    ...withoutBundleHash,
    bundleSha256: sha256Hex(canonicalizeRevision(withoutBundleHash)),
  };
}
