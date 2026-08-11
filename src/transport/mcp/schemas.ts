import { z } from "zod";

const repositoryHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const searchSkillsInputSchema = z
  .object({
    task: z.string().min(1).max(4096),
    repositoryHash: repositoryHashSchema.optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export const searchPreviewSchema = z
  .object({
    rank: z.number().int().min(1).max(10),
    skillId: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    name: z.string().min(1).max(120),
    summary: z.string().min(1).max(512),
    matchingCapabilities: z.array(z.string().min(1).max(80)).max(16),
    trustAtPublication: z.literal("trusted"),
    currentAdvisoryStatus: z.enum(["available", "unavailable", "revoked"]),
    revision: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .max(128),
  })
  .strict();

export const searchSkillsOutputSchema = z
  .object({
    skills: z.array(searchPreviewSchema).max(10),
  })
  .strict();
