import { z } from "zod";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const OwnedAssetSchema = z
  .object({
    assetId: z.uuid(),
    kind: z.enum([
      "path",
      "release",
      "trust-policy",
      "service-secret",
      "compose-project",
      "container",
      "volume",
      "credential",
      "mcp-entry",
      "plugin",
      "marketplace",
      "backup",
      "source-registration",
    ]),
    client: z.enum(["codex", "claude"]).nullable(),
    locator: z.string().min(1).max(512),
    expectedIdentitySha256: Sha256Schema,
    createdByOperation: z.uuid(),
    retention: z.enum([
      "remove-on-uninstall",
      "retain-by-default",
      "remove-only-on-purge",
    ]),
    disposition: z.enum([
      "present",
      "removed",
      "retained",
      "drifted",
      "ambiguous",
    ]),
  })
  .strict();

export const ExternalIntegrationDependencySchema = z
  .object({
    schemaVersion: z.literal("skillwire.external-integration/v1"),
    externalDependencyId: z.uuid(),
    client: z.enum(["codex", "claude"]),
    kind: z.enum(["mcp-entry", "plugin", "marketplace"]),
    scope: z.enum(["user", "managed", "effective"]),
    observedIdentitySha256: Sha256Schema,
    verification: z.enum([
      "equivalent",
      "conflicting",
      "ambiguous",
      "managed",
      "unavailable",
    ]),
    lastObservedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const OwnershipRecordSchema = z
  .object({
    schemaVersion: z.literal("skillwire.ownership/v1"),
    installationId: z.uuid(),
    recordRevision: z.number().int().positive(),
    assets: z.array(OwnedAssetSchema).max(1024),
    externalDependencies: z.array(z.uuid()).max(32),
    recordSha256: Sha256Schema,
  })
  .strict()
  .superRefine(({ assets, externalDependencies }, context) => {
    if (new Set(assets.map(({ assetId }) => assetId)).size !== assets.length) {
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: "duplicate owned asset",
      });
    }
    if (new Set(externalDependencies).size !== externalDependencies.length) {
      context.addIssue({
        code: "custom",
        path: ["externalDependencies"],
        message: "duplicate external dependency",
      });
    }
  });

// The small proof is retained for callers that persist one asset at a time.
export const OwnershipProofSchema = z
  .object({
    schemaVersion: z.literal("skillwire.ownership/v1"),
    installationId: z.uuid(),
    assetId: z.string().min(1).max(256),
    kind: z.enum([
      "release",
      "launcher",
      "compose-project",
      "volume",
      "service-secret",
      "client-mcp",
      "client-plugin",
      "client-marketplace",
      "client-credential",
      "client-key",
    ]),
    identitySha256: Sha256Schema,
    createdByOperation: z.uuid(),
  })
  .strict();

export type ExternalDependencyClass =
  "absent" | "external-equivalent" | "same-name-conflict";

export function classifyExternalDependency(
  sameNameExists: boolean,
  equivalent: boolean,
): ExternalDependencyClass {
  if (!sameNameExists) return "absent";
  return equivalent ? "external-equivalent" : "same-name-conflict";
}

export function requireMatchingOwnership(
  expected: z.infer<typeof OwnershipProofSchema>,
  actualIdentitySha256: string,
): void {
  if (expected.identitySha256 !== actualIdentitySha256) {
    throw new Error("Owned asset identity has drifted");
  }
}
