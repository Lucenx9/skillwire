import { assertSafeResourcePath } from "../catalog/resource-path.js";
import { canonicalJson, sha256Hex } from "../catalog/canonical-revision.js";
import { normalizeUtf8 } from "../catalog/text-normalization.js";
import {
  assertGitSha,
  type ExternalSkillRevision,
  type ImportedSkillInput,
  type ExternalPublishedProvenance,
} from "./types.js";

const MAX_RESOURCES = 64;
const MAX_DEPENDENCIES = 32;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

export interface CreateExternalRevisionInput {
  readonly skillId: string;
  readonly provenance: ExternalPublishedProvenance;
  readonly skill: ImportedSkillInput;
}

function normalizedText(value: string): {
  readonly text: string;
  readonly byteLength: number;
} {
  const normalized = normalizeUtf8(Buffer.from(value, "utf8"));
  if (normalized.byteLength > MAX_TEXT_BYTES) throw new Error("TEXT_OVERSIZED");
  return normalized;
}

export function createExternalSkillRevision(
  input: CreateExternalRevisionInput,
): ExternalSkillRevision {
  assertGitSha(input.provenance.commitSha);
  if (input.provenance.repositoryId <= 0)
    throw new Error("INVALID_REPOSITORY_ID");
  if (input.provenance.spdxLicenseId.length === 0)
    throw new Error("LICENSE_MISSING");
  if (input.skill.resources.length > MAX_RESOURCES)
    throw new Error("RESOURCE_OVERSIZED");
  if (input.skill.dependencies.length > MAX_DEPENDENCIES)
    throw new Error("DEPENDENCY_OVERSIZED");

  const instructions = normalizedText(input.skill.instructions);
  const license = normalizedText(input.provenance.licenseText);
  const resources = input.skill.resources
    .map((resource) => {
      assertSafeResourcePath(resource.path);
      const content = normalizedText(resource.content);
      return {
        path: resource.path,
        mediaType: resource.mediaType,
        byteLength: content.byteLength,
        sha256: sha256Hex(content.text),
        content: content.text,
      } as const;
    })
    .toSorted((left, right) => left.path.localeCompare(right.path, "en-US"));
  if (new Set(resources.map(({ path }) => path)).size !== resources.length) {
    throw new Error("DUPLICATE_RESOURCE");
  }
  const dependencies = input.skill.dependencies
    .map((dependency) => ({ ...dependency }))
    .toSorted((left, right) =>
      left.skillName.localeCompare(right.skillName, "en-US"),
    );
  if (
    new Set(dependencies.map(({ skillName }) => skillName)).size !==
    dependencies.length
  ) {
    throw new Error("DUPLICATE_DEPENDENCY");
  }

  const immutableContent = {
    schemaVersion: 2,
    trustAtPublication: "structurally-verified" as const,
    skillId: input.skillId,
    name: input.skill.name,
    description: input.skill.description,
    source: {
      provider: "github",
      repositoryId: input.provenance.repositoryId,
      owner: input.provenance.owner,
      repository: input.provenance.repository,
      skillPath: input.provenance.skillPath,
      sourceOwner: input.provenance.sourceOwner,
      spdxLicenseId: input.provenance.spdxLicenseId,
      licenseSha256: sha256Hex(license.text),
    },
    invocationMode: input.skill.invocationMode,
    instructions: instructions.text,
    resources,
    dependencies,
  } as const;
  const contentIdentitySha256 = sha256Hex(canonicalJson(immutableContent));
  const bundlePayload = {
    ...immutableContent,
    source: {
      ...immutableContent.source,
      commitSha: input.provenance.commitSha,
    },
    licenseText: license.text,
  };
  const canonicalBytes = canonicalJson(bundlePayload);
  if (Buffer.byteLength(canonicalBytes, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error("BUNDLE_OVERSIZED");
  }
  const bundleSha256 = sha256Hex(canonicalBytes);
  return {
    schemaVersion: 2,
    trustAtPublication: "structurally-verified",
    skillId: input.skillId,
    revision: `gh-${bundleSha256}`,
    name: input.skill.name,
    description: input.skill.description,
    provenance: { ...input.provenance, licenseText: license.text },
    invocationMode: input.skill.invocationMode,
    instructions: instructions.text,
    instructionsSha256: sha256Hex(instructions.text),
    resources,
    dependencies,
    contentIdentitySha256,
    bundleSha256,
    canonicalBytes,
  };
}

export function assertExternalRevisionIntegrity(
  revision: ExternalSkillRevision,
): ExternalSkillRevision {
  const reconstructed = createExternalSkillRevision({
    skillId: revision.skillId,
    provenance: revision.provenance,
    skill: {
      name: revision.name,
      description: revision.description,
      skillPath: revision.provenance.skillPath,
      instructions: revision.instructions,
      invocationMode: revision.invocationMode,
      resources: revision.resources.map(({ path, mediaType, content }) => ({
        path,
        mediaType,
        content,
      })),
      dependencies: revision.dependencies,
    },
  });
  if (canonicalJson(reconstructed) !== canonicalJson(revision)) {
    throw new Error("REVISION_INTEGRITY_FAILED");
  }
  return revision;
}
