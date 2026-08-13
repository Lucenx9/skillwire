import { z } from "zod";

const SecretValuePattern =
  /(?:swk\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}|bearer\s+\S+|password\s*[=:]\s*\S+|pepper\s*[=:]\s*\S+)/gi;

export function redactText(value: string): string {
  return value.replace(SecretValuePattern, "[REDACTED]");
}

export const ExitClassSchema = z.enum([
  "success",
  "internal-failure",
  "invalid-invocation",
  "unsupported-prerequisite",
  "policy-or-ownership-conflict",
  "degraded-or-incomplete",
  "service-failure",
  "credential-or-authentication-failure",
  "client-contract-failure",
  "schema-incompatibility",
  "rollback-required",
  "user-cancellation",
  "release-integrity-failure",
]);

const ComponentSchema = z
  .object({
    component: z.string().min(1).max(64),
    state: z.string().min(1).max(64),
    changed: z.boolean(),
    owned: z.boolean(),
    identity: z.record(
      z.string(),
      z.union([z.string().max(128), z.number(), z.boolean(), z.null()]),
    ),
  })
  .strict();

const FindingSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    severity: z.enum(["info", "warning", "error", "recovery-required"]),
    component: z.string().min(1).max(64),
    summary: z.string().min(1).max(512),
    nextAction: z.string().min(1).max(512),
  })
  .strict();

export const AdminResultSchema = z
  .object({
    schemaVersion: z.literal("skillwire.admin-result/v1"),
    command: z.string().min(1).max(64),
    operationId: z.uuid(),
    status: z.enum([
      "preview",
      "success",
      "incomplete",
      "failure",
      "cancelled",
      "recovery-required",
    ]),
    exitClass: ExitClassSchema,
    previewHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    changed: z.boolean(),
    summary: z.string().min(1).max(512),
    components: z.array(ComponentSchema).max(64),
    findings: z.array(FindingSchema).max(128),
    recovery: z
      .object({
        rollbackBoundary: z.enum([
          "automatic",
          "client-only",
          "application-config",
          "database-restore-required",
          "none",
        ]),
        backupId: z.uuid().nullable(),
        instructions: z.array(z.string().min(1).max(512)).max(16),
      })
      .strict(),
  })
  .strict();

export type AdminResult = z.infer<typeof AdminResultSchema>;
export type ExitClass = z.infer<typeof ExitClassSchema>;

export function redactOutput(value: unknown, key = ""): unknown {
  if (
    /^(?:token|secret|password|pepper|accountId|repository)(?:Value|Bytes|Raw)?$/i.test(
      key,
    )
  )
    return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactOutput(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        redactOutput(entry, entryKey),
      ]),
    );
  }
  return value;
}

export function renderAdminResult(
  result: AdminResult,
  format: "human" | "json",
): string {
  const safe = AdminResultSchema.parse(redactOutput(result));
  if (format === "json") return `${JSON.stringify(safe)}\n`;
  return `${safe.status}: ${safe.summary}\n`;
}
