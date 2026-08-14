import { createHash, randomUUID } from "node:crypto";

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

export interface OwnershipLedger {
  readonly record: z.infer<typeof OwnershipRecordSchema>;
  readonly externalIntegrations: readonly z.infer<
    typeof ExternalIntegrationDependencySchema
  >[];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("ownership value is not canonical");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("ownership value is not canonical");
}

function recordHash(
  record: Omit<z.infer<typeof OwnershipRecordSchema>, "recordSha256">,
): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

function updateRecord(
  record: z.infer<typeof OwnershipRecordSchema>,
  update: Partial<
    Pick<
      z.infer<typeof OwnershipRecordSchema>,
      "assets" | "externalDependencies"
    >
  >,
): z.infer<typeof OwnershipRecordSchema> {
  const unsigned = {
    schemaVersion: "skillwire.ownership/v1" as const,
    installationId: record.installationId,
    recordRevision: record.recordRevision + 1,
    assets: update.assets ?? record.assets,
    externalDependencies:
      update.externalDependencies ?? record.externalDependencies,
  };
  return OwnershipRecordSchema.parse({
    ...unsigned,
    recordSha256: recordHash(unsigned),
  });
}

export function createOwnershipLedger(installationId: string): OwnershipLedger {
  const unsigned = {
    schemaVersion: "skillwire.ownership/v1" as const,
    installationId,
    recordRevision: 1,
    assets: [],
    externalDependencies: [],
  };
  return {
    record: OwnershipRecordSchema.parse({
      ...unsigned,
      recordSha256: recordHash(unsigned),
    }),
    externalIntegrations: [],
  };
}

export function verifyOwnershipRecord(
  candidate: unknown,
): z.infer<typeof OwnershipRecordSchema> {
  const parsed = OwnershipRecordSchema.parse(candidate);
  const { recordSha256, ...unsigned } = parsed;
  if (recordHash(unsigned) !== recordSha256)
    throw new Error("Ownership record integrity is invalid");
  return parsed;
}

export function recordExternalIntegration(
  ledger: OwnershipLedger,
  dependency: z.input<typeof ExternalIntegrationDependencySchema>,
): OwnershipLedger {
  const parsed = ExternalIntegrationDependencySchema.parse(dependency);
  if (parsed.verification !== "equivalent")
    throw new Error(
      "Only verified equivalent external integrations are reusable",
    );
  if (
    ledger.externalIntegrations.some(
      ({ client, kind }) => client === parsed.client && kind === parsed.kind,
    ) ||
    ledger.record.externalDependencies.includes(parsed.externalDependencyId)
  ) {
    throw new Error("External integration dependency is already recorded");
  }
  if (
    ledger.record.assets.some(
      ({ client, kind }) => client === parsed.client && kind === parsed.kind,
    )
  ) {
    throw new Error("Integration cannot be both external and owned");
  }
  return {
    record: updateRecord(ledger.record, {
      externalDependencies: [
        ...ledger.record.externalDependencies,
        parsed.externalDependencyId,
      ],
    }),
    externalIntegrations: [...ledger.externalIntegrations, parsed],
  };
}

export function recordOwnedAsset(
  ledger: OwnershipLedger,
  asset: Omit<z.input<typeof OwnedAssetSchema>, "assetId"> & {
    readonly assetId?: string;
  },
): OwnershipLedger {
  const parsed = OwnedAssetSchema.parse({
    assetId: asset.assetId ?? randomUUID(),
    ...asset,
  });
  if (
    parsed.client !== null &&
    ledger.externalIntegrations.some(
      ({ client, kind }) => client === parsed.client && kind === parsed.kind,
    )
  ) {
    throw new Error("Integration cannot be both external and owned");
  }
  return {
    record: updateRecord(ledger.record, {
      assets: [...ledger.record.assets, parsed],
    }),
    externalIntegrations: ledger.externalIntegrations,
  };
}

export type OwnershipRemovalOperation =
  "client-uninstall" | "uninstall" | "purge";

export interface OwnedAssetDispositionPlan {
  readonly remove: readonly z.infer<typeof OwnedAssetSchema>[];
  readonly retain: readonly z.infer<typeof OwnedAssetSchema>[];
}

export function planOwnedAssetDispositions(
  candidate: unknown,
  operation: OwnershipRemovalOperation,
  client?: "codex" | "claude",
): OwnedAssetDispositionPlan {
  const record = verifyOwnershipRecord(candidate);
  if (operation === "client-uninstall" && client === undefined)
    throw new Error("Client uninstall requires an exact client");
  const remove = record.assets.filter((asset) => {
    if (operation === "purge")
      return (
        asset.disposition === "present" || asset.disposition === "retained"
      );
    if (operation === "client-uninstall")
      return (
        asset.client === client &&
        (asset.disposition === "present" ||
          (asset.kind === "credential" && asset.disposition === "retained"))
      );
    if (asset.disposition !== "present") return false;
    return (
      asset.kind === "mcp-entry" ||
      asset.kind === "plugin" ||
      asset.kind === "marketplace" ||
      asset.kind === "container" ||
      asset.kind === "compose-project"
    );
  });
  const removeIds = new Set(remove.map(({ assetId }) => assetId));
  return {
    remove,
    retain: record.assets.filter(({ assetId }) => !removeIds.has(assetId)),
  };
}

export function requireCurrentOwnedAssetIdentity(
  asset: z.infer<typeof OwnedAssetSchema>,
  currentIdentitySha256: string,
): void {
  if (asset.disposition === "ambiguous" || asset.disposition === "drifted")
    throw new Error("Owned asset is ambiguous or drifted");
  if (asset.disposition !== "present" && asset.disposition !== "retained")
    throw new Error("Owned asset is not currently removable");
  if (asset.expectedIdentitySha256 !== currentIdentitySha256)
    throw new Error("Owned asset identity changed after preview");
}

export function recordAssetDisposition(
  candidate: unknown,
  assetId: string,
  disposition: "removed" | "retained" | "drifted" | "ambiguous",
): z.infer<typeof OwnershipRecordSchema> {
  const record = verifyOwnershipRecord(candidate);
  if (!record.assets.some((asset) => asset.assetId === assetId))
    throw new Error("Owned asset is not recorded");
  return updateRecord(record, {
    assets: record.assets.map((asset) =>
      asset.assetId === assetId ? { ...asset, disposition } : asset,
    ),
  });
}

export function reactivateOwnedAsset(
  candidate: unknown,
  assetId: string,
  currentIdentitySha256: string,
): z.infer<typeof OwnershipRecordSchema> {
  const record = verifyOwnershipRecord(candidate);
  const asset = record.assets.find((entry) => entry.assetId === assetId);
  if (asset === undefined) throw new Error("Owned asset is not recorded");
  if (asset.expectedIdentitySha256 !== currentIdentitySha256)
    throw new Error("Retained owned asset identity changed");
  if (asset.disposition !== "retained" && asset.disposition !== "removed")
    throw new Error("Owned asset is not eligible for reactivation");
  return updateRecord(record, {
    assets: record.assets.map((entry) =>
      entry.assetId === assetId
        ? { ...entry, disposition: "present" as const }
        : entry,
    ),
  });
}

export function replaceOwnedAssetIdentity(
  candidate: unknown,
  assetId: string,
  replacement: {
    readonly locator: string;
    readonly expectedIdentitySha256: string;
  },
): z.infer<typeof OwnershipRecordSchema> {
  const record = verifyOwnershipRecord(candidate);
  if (!/^[0-9a-f]{64}$/.test(replacement.expectedIdentitySha256))
    throw new Error("Replacement owned asset identity is invalid");
  if (!record.assets.some((asset) => asset.assetId === assetId))
    throw new Error("Owned asset is not recorded");
  return updateRecord(record, {
    assets: record.assets.map((asset) =>
      asset.assetId === assetId
        ? {
            ...asset,
            locator: replacement.locator,
            expectedIdentitySha256: replacement.expectedIdentitySha256,
            disposition: "present" as const,
          }
        : asset,
    ),
  });
}
