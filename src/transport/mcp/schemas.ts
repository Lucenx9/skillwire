import { z } from "zod";

const repositoryHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const skillIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80);
const revisionSchema = z
  .string()
  .regex(/^(?!latest$|main$|master$|HEAD$)[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .max(128);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const resourcePathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.?($|\/))(?!.*\\)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/,
  );

const firstPartyPublishedProvenanceSchema = z
  .object({
    source: z
      .object({
        provider: z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .max(64),
        reference: z.string().min(1).max(512),
      })
      .strict(),
    sourceRevision: z.string().min(1).max(128),
    owner: z.string().min(1).max(160),
    license: z.literal("Apache-2.0"),
    trustAtPublication: z.literal("trusted"),
  })
  .strict();

const githubCatalogOriginSchema = z
  .object({
    kind: z.literal("github"),
    owner: z.string().min(1).max(100),
    repository: z.string().min(1).max(100),
    commitSha: gitShaSchema,
    skillPath: z.string().min(1).max(512),
    license: z
      .object({
        spdxId: z
          .string()
          .regex(/^[A-Za-z0-9.+-]+$/)
          .max(64),
        attribution: z.string().min(1).max(200),
        evidenceSha256: sha256Schema.optional(),
        evidencePath: z.string().min(1).max(512).optional(),
        notice: z
          .object({
            sha256: sha256Schema,
            path: z.string().min(1).max(512),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

const externalPublishedProvenanceSchema = z
  .object({
    source: z
      .object({
        provider: z.literal("github"),
        reference: z.string().min(1).max(1024),
      })
      .strict(),
    sourceRevision: gitShaSchema,
    owner: z.string().min(1).max(200),
    license: z
      .string()
      .regex(/^[A-Za-z0-9.+-]+$/)
      .max(64),
    trustAtPublication: z.literal("structurally-verified"),
  })
  .strict();

const resourceManifestEntrySchema = z
  .object({
    path: resourcePathSchema,
    mediaType: z.enum(["text/markdown", "text/plain"]),
    byteLength: z.number().int().min(0).max(262_144),
    sha256: sha256Schema,
  })
  .strict();

export const searchSkillsInputSchema = z
  .object({
    task: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (task) =>
          task.trim().length > 0 && Buffer.byteLength(task, "utf8") <= 4096,
      ),
    repositoryHash: repositoryHashSchema.optional(),
    limit: z.number().int().min(1).max(10).optional(),
    invocationContext: z.enum(["automatic", "user-requested"]).optional(),
  })
  .strict();

const firstPartySearchPreviewSchema = z
  .object({
    rank: z.number().int().min(1).max(10),
    skillId: skillIdSchema,
    name: z.string().min(1).max(120),
    summary: z.string().min(1).max(512),
    matchingCapabilities: z.array(z.string().min(1).max(80)).max(16),
    trustAtPublication: z.literal("trusted"),
    currentAdvisoryStatus: z.enum(["available", "unavailable", "revoked"]),
    revision: revisionSchema,
  })
  .strict();

const externalSearchPreviewSchema = z
  .object({
    rank: z.number().int().min(1).max(10),
    skillId: skillIdSchema,
    name: z.string().min(1).max(120),
    summary: z.string().min(1).max(1024),
    matchingCapabilities: z.array(z.string().min(1).max(80)).max(16),
    trustAtPublication: z.literal("structurally-verified"),
    currentAdvisoryStatus: z.literal("available"),
    revision: revisionSchema,
    catalogOrigin: githubCatalogOriginSchema,
    currentClassification: z.enum(["verified", "curated"]),
    invocationMode: z.enum(["automatic", "user-only"]),
  })
  .strict();

export const searchPreviewSchema = z.union([
  firstPartySearchPreviewSchema,
  externalSearchPreviewSchema,
]);

export const searchSkillsOutputSchema = z
  .object({
    skills: z.array(searchPreviewSchema).max(10),
  })
  .strict();

export const loadSkillInputSchema = z
  .object({
    skillId: skillIdSchema,
    revision: revisionSchema,
    repositoryHash: repositoryHashSchema.optional(),
  })
  .strict();

const dependencySchema = z
  .object({
    skillId: skillIdSchema,
    revision: revisionSchema,
    required: z.boolean(),
    evidenceKind: z.enum(["manifest", "frontmatter", "explicit-invocation"]),
  })
  .strict();

const loadSkillOutputBaseSchema = z
  .object({
    skillId: skillIdSchema,
    revision: revisionSchema,
    revisionSha256: sha256Schema,
    publishedProvenance: z.union([
      firstPartyPublishedProvenanceSchema,
      externalPublishedProvenanceSchema,
    ]),
    currentAdvisoryStatus: z.enum(["available", "unavailable", "revoked"]),
    instructions: z.string().max(262_144),
    resourceManifest: z.array(resourceManifestEntrySchema).max(64),
    memoryRecorded: z.boolean(),
    catalogOrigin: githubCatalogOriginSchema.optional(),
    currentClassification: z.enum(["verified", "curated"]).optional(),
    invocationMode: z.enum(["automatic", "user-only"]).optional(),
    dependencies: z.array(dependencySchema).max(32).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const imported =
      value.publishedProvenance.trustAtPublication === "structurally-verified";
    const hasAllImportedFields =
      value.catalogOrigin !== undefined &&
      value.currentClassification !== undefined &&
      value.invocationMode !== undefined &&
      value.dependencies !== undefined;
    if (imported !== hasAllImportedFields) {
      context.addIssue({
        code: "custom",
        message: "Imported response provenance fields are inconsistent",
      });
    }
  });

export const loadSkillOutputSchema = loadSkillOutputBaseSchema;

export const readSkillResourceInputSchema = z
  .object({
    skillId: skillIdSchema,
    revision: revisionSchema,
    path: resourcePathSchema,
  })
  .strict();

export const readSkillResourceOutputSchema = z
  .object({
    skillId: skillIdSchema,
    revision: revisionSchema,
    revisionSha256: sha256Schema,
    path: resourcePathSchema,
    mediaType: z.enum(["text/markdown", "text/plain"]),
    byteLength: z.number().int().min(0).max(262_144),
    sha256: sha256Schema,
    content: z.string().max(262_144),
  })
  .strict();

const outcomeSchema = z.enum(["useful", "neutral", "unsuccessful"]);

const memoryEntrySchema = z
  .object({
    skillId: skillIdSchema,
    revision: revisionSchema,
    revisionSha256: sha256Schema,
    firstUsedAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime(),
    usageCount: z.number().int().min(1),
    outcome: outcomeSchema.optional(),
  })
  .strict();

export const listRepoMemoryInputSchema = z
  .object({ repositoryHash: repositoryHashSchema })
  .strict();

export const listRepoMemoryOutputSchema = z
  .object({ entries: z.array(memoryEntrySchema).max(100) })
  .strict();

export const recordSkillOutcomeInputSchema = z
  .object({
    repositoryHash: repositoryHashSchema,
    skillId: skillIdSchema,
    revision: revisionSchema,
    outcome: outcomeSchema,
  })
  .strict();

export const recordSkillOutcomeOutputSchema = z
  .object({
    recorded: z.literal(true),
    skillId: skillIdSchema,
    revision: revisionSchema,
    outcome: outcomeSchema,
  })
  .strict();

export const forgetRepoMemoryInputSchema = z
  .object({ repositoryHash: repositoryHashSchema })
  .strict();

export const forgetRepoMemoryOutputSchema = z
  .object({ forgotten: z.literal(true) })
  .strict();
