import { z } from "zod";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const RelativeLocatorSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\0") &&
      !value.split("/").includes(".."),
    "unsafe relative locator",
  );

export const ServiceSecretReferenceSchema = z
  .object({
    kind: z.enum(["database-password", "application-pepper"]),
    relativePath: z
      .string()
      .regex(/^secrets\/(database-password|application-pepper)$/),
    identitySha256: Sha256Schema,
    state: z.enum(["created", "reused", "retained"]).optional(),
  })
  .strict()
  .refine(
    ({ kind, relativePath }) => relativePath === `secrets/${kind}`,
    "secret kind and locator differ",
  );

export const ServiceSecretSetSchema = z
  .object({
    schemaVersion: z.literal("skillwire.service-secret-set/v1"),
    serviceSecretSetId: z.uuid(),
    installationId: z.uuid(),
    secrets: z.array(ServiceSecretReferenceSchema).length(2),
    createdByOperation: z.uuid(),
    state: z.enum(["available", "rotating", "invalid", "retained", "removed"]),
  })
  .strict()
  .superRefine(({ secrets }, context) => {
    const kinds = new Set(secrets.map(({ kind }) => kind));
    if (kinds.size !== 2) {
      context.addIssue({
        code: "custom",
        path: ["secrets"],
        message: "both service-secret kinds must occur exactly once",
      });
    }
  });

const ClientStateSchema = z.enum([
  "planned",
  "credential-stored",
  "mcp-registered",
  "adapter-installed",
  "verified",
  "external-verified",
  "compensating",
  "failed",
  "removed",
  "retained-external",
]);

export const ClientIntegrationSchema = z
  .object({
    schemaVersion: z.literal("skillwire.client-integration/v1"),
    clientIntegrationId: z.uuid(),
    installationId: z.uuid(),
    client: z.enum(["codex", "claude"]),
    clientVersion: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/),
    profileScope: z.literal("normal-user"),
    state: ClientStateSchema,
    credentialReferenceId: z.uuid().nullable(),
    keyPublicIdHash: Sha256Schema.nullable(),
    mcpIdentitySha256: Sha256Schema,
    adapterIdentitySha256: Sha256Schema,
  })
  .strict();

const InstallationStatusSchema = z.enum([
  "prepared",
  "service-ready",
  "complete",
  "incomplete",
  "data-retained",
  "recovery-required",
  "purged",
]);

function localEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === "unix:" &&
      endpoint.hostname === "" &&
      endpoint.pathname.startsWith("/") &&
      endpoint.pathname.endsWith("/mcp.sock") &&
      endpoint.search === "" &&
      endpoint.hash === "" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.port === ""
    );
  } catch {
    return false;
  }
}

export const InstallationSchema = z
  .object({
    schemaVersion: z.literal("skillwire.installation/v1"),
    installationId: z.uuid(),
    ownerUid: z.number().int().nonnegative(),
    accountId: z.uuid(),
    activeReleaseId: z.string().min(1).max(128),
    highestAcceptedReleaseSequence: z.number().int().positive(),
    activeTrustPolicySequence: z.number().int().positive(),
    endpoint: z
      .string()
      .max(1024)
      .refine(localEndpoint, "endpoint must be an exact local Unix socket"),
    composeProject: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    postgresVolume: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/),
    selectedClients: z.array(z.enum(["codex", "claude"])).max(2),
    clientIntegrationIds: z
      .object({ codex: z.uuid().nullable(), claude: z.uuid().nullable() })
      .strict(),
    status: InstallationStatusSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    lastValidatedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine(({ selectedClients, clientIntegrationIds }, context) => {
    if (new Set(selectedClients).size !== selectedClients.length) {
      context.addIssue({
        code: "custom",
        path: ["selectedClients"],
        message: "duplicate selected client",
      });
    }
    for (const client of ["codex", "claude"] as const) {
      if (
        !selectedClients.includes(client) &&
        clientIntegrationIds[client] !== null
      ) {
        context.addIssue({
          code: "custom",
          path: ["clientIntegrationIds", client],
          message: "unselected client has an integration",
        });
      }
    }
  });

export const CredentialReferenceSchema = z
  .object({
    schemaVersion: z.literal("skillwire.credential-reference/v1"),
    credentialReferenceId: z.uuid(),
    installationId: z.uuid(),
    client: z.enum(["codex", "claude"]),
    backend: z.enum(["secret-service", "restrictive-file"]),
    locator: RelativeLocatorSchema,
    keyPublicIdHash: Sha256Schema.nullable(),
    createdByOperation: z.uuid(),
    state: z.enum([
      "available",
      "missing",
      "locked",
      "rejected",
      "retained",
      "removed",
    ]),
    fallbackRiskConfirmed: z.boolean(),
  })
  .strict()
  .refine(
    ({ backend, fallbackRiskConfirmed }) =>
      backend === "secret-service" || fallbackRiskConfirmed,
    "restrictive-file fallback requires separate confirmation",
  );

export const ProfileSnapshotSchema = z
  .object({
    schemaVersion: z.literal("skillwire.profile-snapshot/v1"),
    snapshotId: z.uuid(),
    client: z.enum(["codex", "claude"]),
    scope: z.literal("normal-user"),
    capturedPaths: z.array(RelativeLocatorSchema).max(16),
    beforeIdentitySha256: Sha256Schema,
    expectedPostIdentitySha256: Sha256Schema.nullable(),
    protectedCopy: RelativeLocatorSchema,
    restorationState: z.enum([
      "not-needed",
      "eligible",
      "restored",
      "blocked-by-concurrent-change",
      "retained",
    ]),
  })
  .strict();

export const BackupRecordSchema = z
  .object({
    schemaVersion: z.literal("skillwire.backup/v1"),
    backupId: z.uuid(),
    installationId: z.uuid(),
    status: z.enum([
      "candidate",
      "validated",
      "invalid",
      "retained",
      "removed",
    ]),
    createdAt: TimestampSchema,
    archiveSha256: Sha256Schema,
    sourceReleaseId: z.string().min(1).max(128),
    serviceSecretReferences: z.array(ServiceSecretReferenceSchema).max(2),
    clientCredentialReferences: z.array(z.uuid()).max(2),
  })
  .strict();

export const VerificationRecordSchema = z
  .object({
    schemaVersion: z.literal("skillwire.verification/v1"),
    verificationId: z.uuid(),
    installationId: z.uuid(),
    client: z.enum(["codex", "claude"]),
    clientVersion: z.string().min(1).max(32),
    verifiedAt: TimestampSchema,
    tools: z.tuple([
      z.literal("search_skills"),
      z.literal("load_skill"),
      z.literal("read_skill_resource"),
      z.literal("list_repo_memory"),
      z.literal("record_skill_outcome"),
      z.literal("forget_repo_memory"),
    ]),
    contractSha256: Sha256Schema,
    provenanceCheck: z.boolean(),
    advisoryCheck: z.boolean(),
    result: z.enum(["passed", "failed"]),
  })
  .strict()
  .refine(
    ({ result, provenanceCheck, advisoryCheck }) =>
      result !== "passed" || (provenanceCheck && advisoryCheck),
    "passing verification requires provenance and advisory checks",
  );

export const SourceChoiceSchema = z
  .object({
    schemaVersion: z.literal("skillwire.source-choice/v1"),
    sourceChoiceId: z.uuid(),
    source: z.enum(["mattpocock/skills", "obra/superpowers"]),
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
  .refine(
    ({ selected, syncState }) => selected || syncState === "not-selected",
    "an unselected source cannot have lifecycle state",
  );

export type Installation = z.infer<typeof InstallationSchema>;
export type ClientIntegration = z.infer<typeof ClientIntegrationSchema>;

const installationTransitions: Readonly<
  Record<Installation["status"], readonly Installation["status"][]>
> = {
  prepared: ["service-ready", "incomplete", "recovery-required"],
  "service-ready": [
    "complete",
    "incomplete",
    "data-retained",
    "recovery-required",
  ],
  complete: ["incomplete", "data-retained", "recovery-required"],
  incomplete: ["complete", "data-retained", "recovery-required"],
  "data-retained": ["service-ready", "purged", "recovery-required"],
  "recovery-required": ["service-ready", "data-retained", "purged"],
  purged: [],
};

const clientTransitions: Readonly<
  Record<ClientIntegration["state"], readonly ClientIntegration["state"][]>
> = {
  planned: ["credential-stored", "external-verified", "failed"],
  "credential-stored": ["mcp-registered", "compensating"],
  "mcp-registered": ["adapter-installed", "compensating"],
  "adapter-installed": ["verified", "compensating"],
  verified: ["removed", "compensating"],
  "external-verified": ["retained-external"],
  compensating: ["failed"],
  failed: ["planned"],
  removed: ["planned"],
  "retained-external": ["external-verified"],
};

export function transitionInstallation(
  installation: Installation,
  status: Installation["status"],
): Installation {
  if (!installationTransitions[installation.status].includes(status)) {
    throw new Error(
      `Invalid installation transition: ${installation.status} -> ${status}`,
    );
  }
  return {
    ...installation,
    status,
    updatedAt: new Date().toISOString(),
    lastValidatedAt: ["service-ready", "complete"].includes(status)
      ? new Date().toISOString()
      : installation.lastValidatedAt,
  };
}

export function transitionClientIntegration(
  integration: ClientIntegration,
  state: ClientIntegration["state"],
): ClientIntegration {
  if (!clientTransitions[integration.state].includes(state)) {
    throw new Error(
      `Invalid client transition: ${integration.state} -> ${state}`,
    );
  }
  return { ...integration, state };
}
