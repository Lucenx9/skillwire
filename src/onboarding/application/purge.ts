import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

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
    stats.uid !== process.getuid?.() ||
    (stats.isDirectory() && (stats.mode & 0o022) !== 0)
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
  const target = resolve(path);
  const root = resolve(protectedRoot);
  const parent = dirname(target);
  await validateProtectedDirectoryChain(parent, root);
  await validateOwnedFilesystemTree(target, root, allowedFiles);
  const validated = await lstat(target, { bigint: true });
  const parentIdentity = await lstat(parent, { bigint: true });
  if (validated.dev !== parentIdentity.dev)
    throw new Error("Purge target cannot be quarantined on another filesystem");

  const quarantine = await createProtectedQuarantine(parent);
  const staged = resolve(quarantine, basename(target));
  let renamed = false;
  let stagedIdentityVerified = false;
  try {
    await rename(target, staged);
    renamed = true;
    const stagedIdentity = await lstat(staged, { bigint: true });
    if (
      stagedIdentity.dev !== validated.dev ||
      stagedIdentity.ino !== validated.ino
    )
      throw new Error(
        "Purge target identity changed while entering protected quarantine",
      );
    stagedIdentityVerified = true;
    const stagedAllowed = allowedFiles?.map((candidate) => {
      const current = resolve(candidate);
      if (!contained(target, current))
        throw new Error("Purge allowed-file identity escapes its owned tree");
      return resolve(staged, relative(target, current));
    });
    await validateOwnedFilesystemTree(staged, quarantine, stagedAllowed);
    const beforeRemoval = await lstat(staged, { bigint: true });
    if (
      beforeRemoval.dev !== validated.dev ||
      beforeRemoval.ino !== validated.ino
    )
      throw new Error(
        "Quarantined purge target identity changed before removal",
      );
    await rm(staged, { recursive: true });
    await rmdir(quarantine);
  } catch (error) {
    if (!renamed) {
      await rmdir(quarantine).catch(() => undefined);
      throw error;
    }
    let restored = false;
    let restoredAtOriginalPath = false;
    if (stagedIdentityVerified) {
      try {
        const current = await lstat(staged, { bigint: true });
        if (current.dev === validated.dev && current.ino === validated.ino) {
          let originalAbsent = false;
          try {
            await lstat(target);
          } catch (targetError) {
            if (
              targetError instanceof Error &&
              "code" in targetError &&
              targetError.code === "ENOENT"
            )
              originalAbsent = true;
            else throw targetError;
          }
          if (originalAbsent) {
            await rename(staged, target);
            const restoredIdentity = await lstat(target, { bigint: true });
            if (
              restoredIdentity.dev === validated.dev &&
              restoredIdentity.ino === validated.ino
            ) {
              restoredAtOriginalPath = true;
              await rmdir(quarantine);
              restored = true;
            }
          }
        }
      } catch {
        restored = false;
      }
    }
    if (restored)
      throw new Error(
        "Purge removal failed; the identity-proven owned target was restored for a safe retry",
        { cause: error },
      );
    if (restoredAtOriginalPath)
      throw new Error(
        `Purge removal failed; the retained target was restored but quarantine cleanup requires recovery at ${quarantine}`,
        { cause: error },
      );
    throw new Error(
      `Purge removal requires recovery; the retained target is isolated at ${quarantine}`,
      { cause: error },
    );
  }
}

async function validateProtectedDirectoryChain(
  directory: string,
  protectedRoot: string,
): Promise<void> {
  const root = resolve(protectedRoot);
  const target = resolve(directory);
  if (!contained(root, target))
    throw new Error("Purge quarantine parent escapes its protected root");
  const suffix = relative(root, target);
  const directories = [
    root,
    ...suffix
      .split(/[/\\]/u)
      .filter(Boolean)
      .map((_, index, segments) =>
        resolve(root, ...segments.slice(0, index + 1)),
      ),
  ];
  for (const candidate of directories) {
    const handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stats = await handle.stat();
      if (
        !stats.isDirectory() ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o022) !== 0
      )
        throw new Error("Purge quarantine directory is unsafe");
    } finally {
      await handle.close();
    }
  }
}

async function createProtectedQuarantine(parent: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = resolve(
      parent,
      `.skillwire-purge-${randomBytes(16).toString("hex")}`,
    );
    try {
      await mkdir(candidate, { mode: 0o700 });
      const stats = await lstat(candidate);
      if (
        !stats.isDirectory() ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o700
      )
        throw new Error("Purge quarantine directory is unsafe");
      return candidate;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        continue;
      throw error;
    }
  }
  throw new Error("Unable to create a unique purge quarantine directory");
}
