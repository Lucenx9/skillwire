import { constants } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { canonicalPreview, confirmPreview } from "../cli/confirmation.js";
import {
  planOwnedAssetDispositions,
  recordAssetDisposition,
  requireCurrentOwnedAssetIdentity,
} from "../domain/ownership.js";
import type { z } from "zod";
import type {
  OwnedAssetSchema,
  OwnershipRecordSchema,
} from "../domain/ownership.js";
import type { OperationJournal } from "../domain/operation-journal.js";

type OwnedAsset = z.infer<typeof OwnedAssetSchema>;
type OwnershipRecord = z.infer<typeof OwnershipRecordSchema>;

export interface PurgePreview {
  readonly installationId: string;
  readonly ownershipRevision: number;
  readonly unrecoverable: readonly OwnedAsset[];
  readonly previewHash: string;
}

export function previewPurge(ownership: unknown): PurgePreview {
  const record = ownership as OwnershipRecord;
  const plan = planOwnedAssetDispositions(ownership, "purge");
  const unrecoverable = [...plan.remove].sort((left, right) => {
    const leftPriority = left.kind === "path" ? 1 : 0;
    const rightPriority = right.kind === "path" ? 1 : 0;
    return leftPriority - rightPriority;
  });
  const scope = {
    installationId: record.installationId,
    ownershipRevision: record.recordRevision,
    unrecoverable: unrecoverable.map(
      ({ assetId, kind, client, locator, expectedIdentitySha256 }) => ({
        assetId,
        kind,
        client,
        locator,
        expectedIdentitySha256,
      }),
    ),
  };
  return {
    installationId: record.installationId,
    ownershipRevision: record.recordRevision,
    unrecoverable,
    previewHash: canonicalPreview("purge", scope).hash,
  };
}

export async function runPurge(options: {
  readonly ownership: OwnershipRecord;
  readonly preview: PurgePreview;
  readonly confirmation: string | undefined;
  readonly signal: AbortSignal;
  readonly observeIdentity: (asset: OwnedAsset) => Promise<string>;
  readonly removeAsset: (asset: OwnedAsset) => Promise<void>;
  readonly journal?: OperationJournal | undefined;
}): Promise<{
  readonly removed: readonly string[];
  readonly ownership: OwnershipRecord;
}> {
  confirmPreview(
    { command: "purge", json: "", hash: options.preview.previewHash },
    options.confirmation,
  );
  if (
    options.ownership.installationId !== options.preview.installationId ||
    options.ownership.recordRevision !== options.preview.ownershipRevision
  )
    throw new Error("Purge ownership changed after preview");
  for (const asset of options.preview.unrecoverable) {
    if (options.signal.aborted) throw new Error("Purge cancelled");
    requireCurrentOwnedAssetIdentity(
      asset,
      await options.observeIdentity(asset),
    );
  }
  let ownership = options.ownership;
  const removed: string[] = [];
  for (const asset of options.preview.unrecoverable) {
    if (options.signal.aborted)
      throw new Error("Purge stopped at a recoverable asset boundary");
    requireCurrentOwnedAssetIdentity(
      asset,
      await options.observeIdentity(asset),
    );
    if (options.journal === undefined) await options.removeAsset(asset);
    else
      await options.journal.runEffect({
        step: `purge-${asset.kind}-${asset.assetId}`,
        intent: { assetId: asset.assetId, kind: asset.kind },
        signal: options.signal,
        action: () => options.removeAsset(asset),
        verification: () => ({ assetId: asset.assetId, removed: true }),
      });
    ownership = recordAssetDisposition(ownership, asset.assetId, "removed");
    removed.push(asset.assetId);
  }
  return { removed, ownership };
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function validateTree(
  path: string,
  root: string,
  allowedFiles?: ReadonlySet<string>,
): Promise<void> {
  const target = resolve(path);
  if (!contained(resolve(root), target) || target === resolve(root))
    throw new Error("Purge target escapes or equals its protected root");
  const stats = await lstat(target);
  if (
    stats.isSymbolicLink() ||
    (!stats.isDirectory() && stats.nlink !== 1) ||
    stats.uid !== process.getuid?.()
  )
    throw new Error("Purge target has an unsafe filesystem identity");
  if (stats.isDirectory()) {
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await handle.close();
    for (const name of await readdir(target))
      await validateTree(resolve(target, name), root, allowedFiles);
  } else if (!stats.isFile()) {
    throw new Error("Purge target is not a regular owned filesystem object");
  } else if (allowedFiles !== undefined && !allowedFiles.has(target)) {
    throw new Error("Purge target contains an unknown unowned file");
  }
}

export async function validateOwnedFilesystemTree(
  path: string,
  protectedRoot: string,
  allowedFiles?: readonly string[],
): Promise<void> {
  const allowed =
    allowedFiles === undefined
      ? undefined
      : new Set(allowedFiles.map((candidate) => resolve(candidate)));
  await validateTree(path, protectedRoot, allowed);
}

export async function removeOwnedFilesystemTree(
  path: string,
  protectedRoot: string,
  allowedFiles?: readonly string[],
): Promise<void> {
  await validateOwnedFilesystemTree(path, protectedRoot, allowedFiles);
  await rm(path, { recursive: true });
}
