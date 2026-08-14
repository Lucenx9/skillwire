import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

function contained(root: string, target: string): boolean {
  const entry = relative(root, target);
  return entry === "" || (!entry.startsWith("..") && !isAbsolute(entry));
}

export function validateXdgRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error("XDG root must be absolute");
  const normalized = resolve(path);
  if (
    normalized === "/" ||
    normalized === resolve(process.env["HOME"] ?? "/nonexistent")
  ) {
    throw new Error("Unsafe XDG root");
  }
  return normalized;
}

export async function validateOwnedPath(
  path: string,
  root: string,
): Promise<string> {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (!contained(normalizedRoot, normalizedPath))
    throw new Error("Path escapes owned root");
  const entry = relative(normalizedRoot, normalizedPath);
  const parts = entry === "" ? [] : entry.split("/");
  let current = normalizedRoot;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) {
      const part = parts[index];
      if (part === undefined)
        throw new Error("Owned path traversal is invalid");
      current = resolve(current, part);
    }
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink())
        throw new Error("Owned path contains a symbolic link");
      if (stats.uid !== process.getuid?.() || (stats.mode & 0o022) !== 0) {
        throw new Error("Owned path ancestor has unsafe ownership or mode");
      }
      if (index < parts.length - 1 && !stats.isDirectory()) {
        throw new Error("Owned path ancestor is not a directory");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        break;
      throw error;
    }
  }
  return normalizedPath;
}

function requireOwnerAndMode(
  uid: number,
  mode: number,
  expectedMode: number,
): void {
  if (uid !== process.getuid?.())
    throw new Error("Owned path has the wrong owner");
  if ((mode & 0o777) !== expectedMode)
    throw new Error(`Owned path must use mode ${expectedMode.toString(8)}`);
}

export async function validateOwnedDirectory(
  path: string,
  root: string,
): Promise<string> {
  const target = await validateOwnedPath(path, root);
  const stats = await lstat(target);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error("Owned directory is not a real directory");
  requireOwnerAndMode(stats.uid, stats.mode, 0o700);
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(target);
  if (!contained(canonicalRoot, canonicalTarget))
    throw new Error("Owned directory resolves outside its root");
  return target;
}

export async function openOwnedFileNoFollow(
  path: string,
  root: string,
): Promise<FileHandle> {
  const target = await validateOwnedPath(path, root);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1)
      throw new Error("Owned file must be a single regular file");
    requireOwnerAndMode(stats.uid, stats.mode, 0o600);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
