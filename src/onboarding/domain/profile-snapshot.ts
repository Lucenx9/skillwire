import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface ProfileFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly mode: number;
  readonly mtimeNanoseconds: string;
  readonly sha256: string;
  readonly semanticSha256: string;
}

export interface ProfileSnapshotEntry {
  readonly relativePath: string;
  readonly existed: boolean;
  readonly beforeIdentity: ProfileFileIdentity | null;
  readonly expectedPostIdentity: ProfileFileIdentity | null | undefined;
  readonly protectedCopy: string | null;
}

export interface ProtectedProfileSnapshot {
  readonly schemaVersion: "skillwire.profile-snapshot/v1";
  readonly snapshotId: string;
  readonly client: "codex" | "claude";
  readonly profileRoot: string;
  readonly stateRoot: string;
  readonly snapshotRoot: string;
  readonly entries: readonly ProfileSnapshotEntry[];
  readonly restorationState:
    "eligible" | "restored" | "blocked-by-concurrent-change" | "retained";
}

export interface CaptureProfileSnapshotOptions {
  readonly client: "codex" | "claude";
  readonly profileRoot: string;
  readonly stateRoot: string;
  readonly relativePaths: readonly string[];
}

function contained(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function validateRelativePath(path: string): string {
  if (
    path.length < 1 ||
    path.length > 512 ||
    isAbsolute(path) ||
    path.includes("\0") ||
    path.split(/[\\/]/).some((part) => part === ".." || part === "")
  ) {
    throw new Error("Profile snapshot path must be a safe relative path");
  }
  return path.replaceAll("\\", "/");
}

async function validateProfileAncestors(
  root: string,
  target: string,
): Promise<void> {
  if (!contained(root, target))
    throw new Error("Profile path is outside profile root");
  const parts = relative(root, target).split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) throw new Error("Profile path is invalid");
    current = resolve(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink())
        throw new Error("Profile path contains a symlink");
      if (stats.uid !== process.getuid?.())
        throw new Error("Profile path has the wrong owner");
      if (index < parts.length - 1 && !stats.isDirectory())
        throw new Error("Profile path ancestor is not a directory");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
  }
}

async function validateOwnedDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    stats.uid !== process.getuid?.()
  ) {
    throw new Error("Profile snapshot directory is unsafe");
  }
}

async function createOwnedDirectory(
  parent: string,
  name: string,
): Promise<string> {
  await validateOwnedDirectory(parent);
  const path = resolve(parent, name);
  if (!contained(parent, path))
    throw new Error("Snapshot directory escapes its root");
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  });
  await validateOwnedDirectory(path);
  await chmod(path, 0o700);
  return path;
}

function semanticHash(bytes: Buffer): string {
  let semantic = bytes;
  try {
    semantic = Buffer.from(JSON.stringify(JSON.parse(bytes.toString("utf8"))));
  } catch {
    // Byte identity is the semantic fallback for non-JSON client formats.
  }
  return createHash("sha256").update(semantic).digest("hex");
}

async function fileIdentity(
  profileRoot: string,
  relativePath: string,
): Promise<ProfileFileIdentity | null> {
  const target = resolve(profileRoot, relativePath);
  await validateProfileAncestors(profileRoot, target);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  try {
    const [stats, bytes] = await Promise.all([
      handle.stat({ bigint: true }),
      handle.readFile(),
    ]);
    if (
      !stats.isFile() ||
      stats.nlink !== 1n ||
      stats.uid !== BigInt(process.getuid?.() ?? -1) ||
      stats.size > 4n * 1024n * 1024n
    ) {
      throw new Error("Profile snapshot source is unsafe");
    }
    return {
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      size: Number(stats.size),
      mode: Number(stats.mode & 0o777n),
      mtimeNanoseconds: stats.mtimeNs.toString(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      semanticSha256: semanticHash(bytes),
    };
  } finally {
    await handle.close();
  }
}

function sameIdentity(
  left: ProfileFileIdentity | null,
  right: ProfileFileIdentity | null | undefined,
): boolean {
  if (right === undefined) return false;
  if (left === null || right === null) return left === right;
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNanoseconds === right.mtimeNanoseconds &&
    left.sha256 === right.sha256 &&
    left.semanticSha256 === right.semanticSha256
  );
}

function sameRestoredImage(
  left: ProfileFileIdentity | null,
  right: ProfileFileIdentity | null | undefined,
): boolean {
  if (right === undefined) return false;
  if (left === null || right === null) return left === right;
  return (
    left.size === right.size &&
    left.mode === right.mode &&
    left.sha256 === right.sha256 &&
    left.semanticSha256 === right.semanticSha256
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function persistSnapshot(
  snapshot: ProtectedProfileSnapshot,
): Promise<void> {
  const path = resolve(snapshot.snapshotRoot, "snapshot.json");
  const stage = resolve(
    snapshot.snapshotRoot,
    `.snapshot-${randomBytes(8).toString("hex")}.stage`,
  );
  const handle = await open(stage, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(stage, path);
  await syncDirectory(snapshot.snapshotRoot);
}

export async function captureProfileSnapshot(
  options: CaptureProfileSnapshotOptions,
): Promise<ProtectedProfileSnapshot> {
  if (!isAbsolute(options.profileRoot) || !isAbsolute(options.stateRoot))
    throw new Error("Profile and state roots must be absolute");
  if (
    options.relativePaths.length < 1 ||
    options.relativePaths.length > 16 ||
    new Set(options.relativePaths).size !== options.relativePaths.length
  ) {
    throw new Error("Profile snapshot path inventory is invalid");
  }
  const profileRoot = resolve(options.profileRoot);
  const stateRoot = resolve(options.stateRoot);
  await Promise.all([
    validateOwnedDirectory(profileRoot),
    validateOwnedDirectory(stateRoot),
  ]);
  const relativePaths = options.relativePaths.map(validateRelativePath);
  for (const relativePath of relativePaths) {
    await validateProfileAncestors(
      profileRoot,
      resolve(profileRoot, relativePath),
    );
  }
  const snapshotId = randomUUID();
  const skillwireRoot = await createOwnedDirectory(stateRoot, "skillwire");
  const snapshotsRoot = await createOwnedDirectory(skillwireRoot, "snapshots");
  const snapshotRoot = resolve(snapshotsRoot, snapshotId);
  if (!contained(stateRoot, snapshotRoot))
    throw new Error("Snapshot path escapes state root");
  await mkdir(snapshotRoot, { mode: 0o700 });
  await validateOwnedDirectory(snapshotRoot);
  const entries: ProfileSnapshotEntry[] = [];
  try {
    for (const [index, relativePath] of relativePaths.entries()) {
      const identity = await fileIdentity(profileRoot, relativePath);
      let protectedCopy: string | null = null;
      if (identity !== null) {
        protectedCopy = resolve(snapshotRoot, `${String(index)}.copy`);
        const source = await open(
          resolve(profileRoot, relativePath),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const target = await open(protectedCopy, "wx", 0o600);
        try {
          const bytes = await source.readFile();
          if (
            createHash("sha256").update(bytes).digest("hex") !== identity.sha256
          )
            throw new Error("Profile changed while its snapshot was captured");
          await target.writeFile(bytes);
          await target.sync();
        } finally {
          await Promise.all([source.close(), target.close()]);
        }
      }
      entries.push({
        relativePath,
        existed: identity !== null,
        beforeIdentity: identity,
        expectedPostIdentity: undefined,
        protectedCopy,
      });
    }
    const snapshot: ProtectedProfileSnapshot = {
      schemaVersion: "skillwire.profile-snapshot/v1",
      snapshotId,
      client: options.client,
      profileRoot,
      stateRoot,
      snapshotRoot,
      entries,
      restorationState: "eligible",
    };
    await persistSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function recordExpectedProfilePostImage(
  snapshot: ProtectedProfileSnapshot,
): Promise<ProtectedProfileSnapshot> {
  const entries = await Promise.all(
    snapshot.entries.map(async (entry) => ({
      ...entry,
      expectedPostIdentity: await fileIdentity(
        snapshot.profileRoot,
        entry.relativePath,
      ),
    })),
  );
  const updated = { ...snapshot, entries };
  await persistSnapshot(updated);
  return updated;
}

export async function profileMatchesSnapshotBefore(
  snapshot: ProtectedProfileSnapshot,
): Promise<boolean> {
  for (const entry of snapshot.entries) {
    if (
      !sameRestoredImage(
        await fileIdentity(snapshot.profileRoot, entry.relativePath),
        entry.beforeIdentity,
      )
    ) {
      return false;
    }
  }
  return true;
}

export async function profileMatchesExpectedPostImage(
  snapshot: ProtectedProfileSnapshot,
  relativePaths?: readonly string[],
): Promise<boolean> {
  for (const entry of selectedEntries(snapshot, relativePaths)) {
    if (
      !sameIdentity(
        await fileIdentity(snapshot.profileRoot, entry.relativePath),
        entry.expectedPostIdentity,
      )
    ) {
      return false;
    }
  }
  return true;
}

export async function profileMatchesExpectedPostContent(
  snapshot: ProtectedProfileSnapshot,
  relativePaths?: readonly string[],
): Promise<boolean> {
  for (const entry of selectedEntries(snapshot, relativePaths)) {
    if (
      !sameRestoredImage(
        await fileIdentity(snapshot.profileRoot, entry.relativePath),
        entry.expectedPostIdentity,
      )
    ) {
      return false;
    }
  }
  return true;
}

function selectedEntries(
  snapshot: ProtectedProfileSnapshot,
  relativePaths: readonly string[] | undefined,
): readonly ProfileSnapshotEntry[] {
  if (relativePaths === undefined) return snapshot.entries;
  if (
    relativePaths.length < 1 ||
    new Set(relativePaths).size !== relativePaths.length
  ) {
    throw new Error("Profile checkpoint path selection is invalid");
  }
  return relativePaths.map((relativePath) => {
    const normalized = validateRelativePath(relativePath);
    const entry = snapshot.entries.find(
      (candidate) => candidate.relativePath === normalized,
    );
    if (entry === undefined)
      throw new Error("Profile checkpoint path is outside the snapshot");
    return entry;
  });
}

async function restoreEntry(
  snapshot: ProtectedProfileSnapshot,
  entry: ProfileSnapshotEntry,
): Promise<void> {
  const target = resolve(snapshot.profileRoot, entry.relativePath);
  await validateProfileAncestors(snapshot.profileRoot, target);
  if (!entry.existed) {
    await unlink(target).catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    });
    await syncDirectory(dirname(target));
    return;
  }
  if (entry.protectedCopy === null || entry.beforeIdentity === null)
    throw new Error("Profile snapshot copy is incomplete");
  const copy = await open(
    entry.protectedCopy,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let bytes: Buffer;
  try {
    const stats = await copy.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw new Error("Protected profile copy is unsafe");
    }
    bytes = await copy.readFile();
  } finally {
    await copy.close();
  }
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    entry.beforeIdentity.sha256
  )
    throw new Error("Protected profile copy identity changed");
  const stage = resolve(
    dirname(target),
    `.skillwire-restore-${randomBytes(8).toString("hex")}.stage`,
  );
  const handle = await open(stage, "wx", entry.beforeIdentity.mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(stage, entry.beforeIdentity.mode);
  await rename(stage, target);
  await syncDirectory(dirname(target));
}

export async function restoreProfileSnapshot(
  snapshot: ProtectedProfileSnapshot,
): Promise<ProtectedProfileSnapshot> {
  for (const entry of snapshot.entries) {
    const current = await fileIdentity(
      snapshot.profileRoot,
      entry.relativePath,
    );
    if (!sameIdentity(current, entry.expectedPostIdentity)) {
      const blocked: ProtectedProfileSnapshot = {
        ...snapshot,
        restorationState: "blocked-by-concurrent-change",
      };
      await persistSnapshot(blocked);
      return blocked;
    }
  }
  for (const entry of snapshot.entries) await restoreEntry(snapshot, entry);
  const restored: ProtectedProfileSnapshot = {
    ...snapshot,
    restorationState: "restored",
  };
  await persistSnapshot(restored);
  return restored;
}
