import { z } from "zod";

export const BootstrapSourceSchema = z.enum([
  "mattpocock/skills",
  "obra/superpowers",
]);

export type BootstrapSource = z.infer<typeof BootstrapSourceSchema>;

export const SourceChoiceSchema = z
  .object({
    schemaVersion: z.literal("skillwire.source-choice/v1"),
    sourceChoiceId: z.uuid(),
    source: BootstrapSourceSchema,
    selected: z.boolean(),
    credentialReferenceId: z.uuid().nullable(),
    registrationIdentity: z.string().min(1).max(128).nullable(),
    syncState: z.enum([
      "not-selected",
      "registered",
      "verifying",
      "eligible",
      "quarantined",
      "degraded",
      "failed",
    ]),
  })
  .strict()
  .superRefine((choice, context) => {
    if (!choice.selected) {
      if (
        choice.syncState !== "not-selected" ||
        choice.credentialReferenceId !== null ||
        choice.registrationIdentity !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "an unselected source cannot have lifecycle state",
        });
      }
      return;
    }
    if (
      choice.credentialReferenceId === null &&
      choice.syncState !== "failed"
    ) {
      context.addIssue({
        code: "custom",
        path: ["credentialReferenceId"],
        message: "a selected source requires its separate credential reference",
      });
    }
    if (
      [
        "registered",
        "verifying",
        "eligible",
        "quarantined",
        "degraded",
      ].includes(choice.syncState) &&
      choice.registrationIdentity === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["registrationIdentity"],
        message: "source lifecycle state requires a registration identity",
      });
    }
  });

export type SourceChoice = z.infer<typeof SourceChoiceSchema>;

export const BOOTSTRAP_SOURCES: readonly BootstrapSource[] = Object.freeze([
  "mattpocock/skills",
  "obra/superpowers",
]);

export function sourceCoordinate(source: BootstrapSource): {
  readonly owner: string;
  readonly repository: string;
} {
  const [owner, repository] = source.split("/");
  if (owner === undefined || repository === undefined)
    throw new Error("Bootstrap source identity is invalid");
  return { owner, repository };
}
