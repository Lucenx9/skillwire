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

const SetupPreviewScopeSchema = z
  .object({
    releaseRoot: z.string().min(1).max(1024),
    releaseVersion: z.string().min(1).max(64),
    releaseSequence: z.number().int().positive(),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
    trustPolicySequence: z.number().int().positive(),
    architecture: z.enum(["amd64", "arm64"]),
    clients: z.enum(["none", "codex", "claude", "codex,claude"]),
    endpoint: z.string().min(1).max(1024),
    transport: z.literal("unix-domain-socket"),
    port: z.null(),
    composeProjectPattern: z.literal("skillwire-<installation-id>"),
    postgresVolumePattern: z.literal(
      "skillwire-<installation-id>_postgres_data",
    ),
    serviceSecretRoot: z.string().min(1).max(1024),
    runtimeSocketRoot: z.string().min(1).max(1024),
    credentialBackend: z.enum([
      "secret-service",
      "restrictive-file",
      "not-selected",
    ]),
    fallbackRiskConfirmedByThisPreview: z.boolean(),
    components: z.array(z.string().min(1).max(64)).min(3).max(5),
    volumes: z.array(z.string().min(1).max(128)).length(1),
    retainedOnFailure: z.array(z.string().min(1).max(128)).min(1).max(8),
    catalogChoice: z.literal("deferred"),
  })
  .strict();

const LifecyclePreviewScopeSchema = z
  .record(z.string().min(1).max(64), z.json())
  .refine(
    (value) => JSON.stringify(value).length <= 64 * 1024,
    "preview scope is too large",
  )
  .refine(
    (value) =>
      !/(?:swk\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}|bearer\s+\S+|password\s*[=:]\s*\S+|pepper\s*[=:]\s*\S+)/i.test(
        JSON.stringify(value),
      ),
    "preview scope contains secret material",
  );

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
    previewScope: z
      .union([SetupPreviewScopeSchema, LifecyclePreviewScopeSchema])
      .optional(),
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
  const lines = [`${safe.status}: ${safe.summary}`];
  if (safe.previewHash !== null) lines.push(`approval: ${safe.previewHash}`);
  if (safe.previewScope !== undefined)
    lines.push(`scope: ${JSON.stringify(safe.previewScope)}`);
  return `${lines.join("\n")}\n`;
}
