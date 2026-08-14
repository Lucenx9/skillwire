import { canonicalPreview, confirmPreview } from "../cli/confirmation.js";
import type { ClientName } from "../cli/main.js";

export type RepairObservation =
  "matching" | "missing" | "outdated" | "drifted" | "ambiguous" | "external";

export interface RepairAsset {
  readonly assetId: string;
  readonly kind: string;
  readonly client: ClientName | null;
  readonly locator: string;
  readonly expectedIdentitySha256: string;
  readonly observation: RepairObservation;
  readonly ownershipProven?: boolean | undefined;
}

export interface RepairBlock {
  readonly code:
    | "EXTERNAL_INTEGRATION_NOT_OWNED"
    | "OWNED_ASSET_DRIFTED"
    | "OWNED_ASSET_AMBIGUOUS"
    | "SECRET_ROTATION_REQUIRES_EXPLICIT_COMMAND";
  readonly assetId: string;
}

export interface RepairPlan {
  readonly installationId: string;
  readonly actions: readonly RepairAsset[];
  readonly blocked: readonly RepairBlock[];
  readonly previewHash: string;
}

function blockFor(asset: RepairAsset): RepairBlock | undefined {
  if (asset.kind === "credential" || asset.kind === "service-secret")
    return {
      code: "SECRET_ROTATION_REQUIRES_EXPLICIT_COMMAND",
      assetId: asset.assetId,
    };
  if (asset.observation === "external")
    return { code: "EXTERNAL_INTEGRATION_NOT_OWNED", assetId: asset.assetId };
  if (asset.observation === "drifted" && asset.ownershipProven !== true)
    return { code: "OWNED_ASSET_DRIFTED", assetId: asset.assetId };
  if (asset.observation === "ambiguous")
    return { code: "OWNED_ASSET_AMBIGUOUS", assetId: asset.assetId };
  return undefined;
}

export function planRepair(input: {
  readonly installationId: string;
  readonly assets: readonly RepairAsset[];
}): RepairPlan {
  const blocked = input.assets
    .map(blockFor)
    .filter((value): value is RepairBlock => value !== undefined);
  const actions = input.assets.filter(
    (asset) =>
      blockFor(asset) === undefined &&
      (asset.observation === "missing" ||
        asset.observation === "outdated" ||
        (asset.observation === "drifted" && asset.ownershipProven === true)),
  );
  const scope = {
    installationId: input.installationId,
    actions: actions.map(
      ({ assetId, kind, client, locator, expectedIdentitySha256 }) => ({
        assetId,
        kind,
        client,
        locator,
        expectedIdentitySha256,
      }),
    ),
    blocked,
  };
  return {
    installationId: input.installationId,
    actions,
    blocked,
    previewHash: canonicalPreview("repair", scope).hash,
  };
}

export async function runRepair(options: {
  readonly plan: RepairPlan;
  readonly confirmation: string | undefined;
  readonly signal: AbortSignal;
  readonly observe: (asset: RepairAsset) => Promise<{
    readonly observation: RepairObservation;
    readonly identitySha256: string;
    readonly ownershipProven?: boolean | undefined;
  }>;
  readonly repair: (asset: RepairAsset) => Promise<void>;
  readonly rotate: (asset: RepairAsset) => Promise<void>;
}): Promise<{ readonly changedAssets: readonly string[] }> {
  confirmPreview(
    { command: "repair", json: "", hash: options.plan.previewHash },
    options.confirmation,
  );
  const changedAssets: string[] = [];
  for (const asset of options.plan.actions) {
    if (options.signal.aborted) throw new Error("Repair cancelled");
    const current = await options.observe(asset);
    const repairableDrift =
      asset.observation === "drifted" &&
      asset.ownershipProven === true &&
      current.observation === "drifted" &&
      current.ownershipProven === true;
    if (
      (!repairableDrift &&
        current.identitySha256 !== asset.expectedIdentitySha256) ||
      (current.observation !== "missing" &&
        current.observation !== "outdated" &&
        !repairableDrift)
    ) {
      continue;
    }
    await options.repair(asset);
    changedAssets.push(asset.assetId);
  }
  return { changedAssets };
}
