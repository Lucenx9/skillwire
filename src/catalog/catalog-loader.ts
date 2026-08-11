import { z } from "zod";

import inventoryJson from "../../catalog/inventory.json" with { type: "json" };
import type { CatalogSkillMetadata } from "../domain/catalog/types.js";

const skillMetadataSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(512),
    capabilities: z.array(z.string().min(1).max(80)).min(1).max(16),
    revision: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .max(128),
    trustAtPublication: z.literal("trusted"),
    currentAdvisoryStatus: z.enum(["available", "unavailable", "revoked"]),
  })
  .strict();

const inventorySchema = z
  .array(skillMetadataSchema)
  .length(10)
  .superRefine((entries, context) => {
    const identifiers = entries.map((entry) => entry.id);
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: "custom",
        message: "Skill identifiers must be unique",
      });
    }
    const sorted = identifiers.toSorted((left, right) =>
      left.localeCompare(right, "en-US"),
    );
    if (identifiers.some((identifier, index) => identifier !== sorted[index])) {
      context.addIssue({
        code: "custom",
        message: "Inventory must be sorted by skill id",
      });
    }
  });

export function loadCatalogMetadata(): readonly CatalogSkillMetadata[] {
  const parsed = inventorySchema.parse(inventoryJson);
  return Object.freeze(
    parsed.map((entry) =>
      Object.freeze({
        ...entry,
        capabilities: Object.freeze(entry.capabilities),
      }),
    ),
  );
}
