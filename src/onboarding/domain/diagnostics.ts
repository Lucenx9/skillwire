import { z } from "zod";

const SafeTextSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => !/swk\.|bearer\s|password|pepper/i.test(value),
    "diagnostic text may contain a secret",
  );

const SafeEvidenceValueSchema = z
  .union([z.string().max(128), z.number(), z.boolean(), z.null()])
  .refine(
    (value) =>
      typeof value !== "string" ||
      !/(?:swk\.|bearer\s|password\s*[=:]|pepper\s*[=:])/i.test(value),
    "diagnostic evidence may contain a secret",
  );

export const DiagnosticFindingSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    severity: z.enum(["info", "warning", "error", "recovery-required"]),
    component: z.enum([
      "release",
      "trust-policy",
      "signing",
      "dispatcher",
      "filesystem",
      "docker",
      "postgres",
      "migration",
      "catalog",
      "advisory",
      "service-secret",
      "credential",
      "bridge",
      "codex",
      "claude",
      "mcp-contract",
      "activation",
      "source",
      "backup",
      "journal",
      "setup",
    ]),
    summary: SafeTextSchema,
    nextAction: SafeTextSchema,
    evidence: z
      .record(
        z
          .string()
          .max(64)
          .refine(
            (key) => !/token|secret|password|pepper|account/i.test(key),
            "diagnostic evidence key may name a secret",
          ),
        SafeEvidenceValueSchema,
      )
      .refine((value) => Object.keys(value).length <= 16, "too much evidence"),
  })
  .strict();

export type DiagnosticFinding = z.infer<typeof DiagnosticFindingSchema>;
