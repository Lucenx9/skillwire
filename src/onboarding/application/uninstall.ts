import { canonicalPreview, confirmPreview } from "../cli/confirmation.js";
import {
  planOwnedAssetDispositions,
  recordAssetDisposition,
  requireCurrentOwnedAssetIdentity,
  type OwnedAssetDispositionPlan,
} from "../domain/ownership.js";
import type { z } from "zod";
import type {
  OwnedAssetSchema,
  OwnershipRecordSchema,
} from "../domain/ownership.js";
import type { OperationJournal } from "../domain/operation-journal.js";

type OwnedAsset = z.infer<typeof OwnedAssetSchema>;
type OwnershipRecord = z.infer<typeof OwnershipRecordSchema>;

export interface DefaultUninstallPreview {
  readonly installationId: string;
  readonly ownershipRevision: number;
  readonly remove: readonly OwnedAsset[];
  readonly retain: readonly OwnedAsset[];
  readonly previewHash: string;
}

export function previewDefaultUninstall(
  ownership: unknown,
): DefaultUninstallPreview {
  const plan: OwnedAssetDispositionPlan = planOwnedAssetDispositions(
    ownership,
    "uninstall",
  );
  const record = ownership as OwnershipRecord;
  const scope = {
    installationId: record.installationId,
    ownershipRevision: record.recordRevision,
    remove: plan.remove.map(
      ({ assetId, kind, client, locator, expectedIdentitySha256 }) => ({
        assetId,
        kind,
        client,
        locator,
        expectedIdentitySha256,
      }),
    ),
    retain: plan.retain.map(({ assetId, kind, client, locator }) => ({
      assetId,
      kind,
      client,
      locator,
    })),
  };
  return {
    installationId: record.installationId,
    ownershipRevision: record.recordRevision,
    remove: plan.remove,
    retain: plan.retain,
    previewHash: canonicalPreview("uninstall", scope).hash,
  };
}

export async function runDefaultUninstall(options: {
  readonly ownership: OwnershipRecord;
  readonly preview: DefaultUninstallPreview;
  readonly confirmation: string | undefined;
  readonly signal: AbortSignal;
  readonly observeIdentity: (asset: OwnedAsset) => Promise<string>;
  readonly removeAsset: (asset: OwnedAsset) => Promise<void>;
  readonly stopOwnedService: () => Promise<void>;
  readonly publishRetained: (ownership: OwnershipRecord) => Promise<void>;
  readonly journal?: OperationJournal | undefined;
}): Promise<{
  readonly removed: readonly string[];
  readonly retained: readonly string[];
  readonly ownership: OwnershipRecord;
}> {
  confirmPreview(
    { command: "uninstall", json: "", hash: options.preview.previewHash },
    options.confirmation,
  );
  if (
    options.ownership.installationId !== options.preview.installationId ||
    options.ownership.recordRevision !== options.preview.ownershipRevision
  )
    throw new Error("Uninstall ownership changed after preview");
  for (const asset of options.preview.remove) {
    if (options.signal.aborted) throw new Error("Uninstall cancelled");
    requireCurrentOwnedAssetIdentity(
      asset,
      await options.observeIdentity(asset),
    );
  }
  let ownership = options.ownership;
  const removed: string[] = [];
  const effect = async (
    step: string,
    action: () => Promise<void>,
    detail: Record<string, string | number | boolean | null>,
  ): Promise<void> => {
    if (options.journal === undefined) return action();
    await options.journal.runEffect({
      step,
      intent: detail,
      signal: options.signal,
      action,
      verification: () => ({ ...detail, completed: true }),
    });
  };
  for (const asset of options.preview.remove) {
    if (options.signal.aborted)
      throw new Error("Uninstall stopped at a recoverable asset boundary");
    requireCurrentOwnedAssetIdentity(
      asset,
      await options.observeIdentity(asset),
    );
    await effect(
      `uninstall-${asset.kind}-${asset.assetId}`,
      () => options.removeAsset(asset),
      { assetId: asset.assetId, kind: asset.kind },
    );
    ownership = recordAssetDisposition(ownership, asset.assetId, "removed");
    removed.push(asset.assetId);
  }
  await effect("uninstall-owned-service", options.stopOwnedService, {
    installationId: options.preview.installationId,
  });
  for (const asset of options.preview.retain) {
    if (asset.disposition === "present")
      ownership = recordAssetDisposition(ownership, asset.assetId, "retained");
  }
  await effect(
    "uninstall-retained-state",
    () => options.publishRetained(ownership),
    { ownershipRevision: ownership.recordRevision },
  );
  return {
    removed,
    retained: options.preview.retain.map(({ assetId }) => assetId),
    ownership,
  };
}
