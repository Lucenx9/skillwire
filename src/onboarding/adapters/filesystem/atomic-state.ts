import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { validateOwnedDirectory, validateOwnedPath } from "./safe-paths.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite JSON number");
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
  throw new Error("Unsupported JSON value");
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

export async function atomicWriteJson(
  path: string,
  value: unknown,
  root: string,
): Promise<void> {
  const target = await validateOwnedPath(path, root);
  const directory = dirname(target);
  await validateOwnedDirectory(directory, root);
  try {
    const existing = await lstat(target);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      existing.uid !== process.getuid?.() ||
      (existing.mode & 0o777) !== 0o600
    ) {
      throw new Error("Existing atomic state target is unsafe");
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const stage = resolve(directory, `.${randomBytes(12).toString("hex")}.stage`);
  const bytes = `${canonicalJson(value)}\n`;
  const handle = await open(stage, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(stage).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(stage, target);
  await syncDirectory(directory);
}

export interface FileIdentity {
  readonly size: number;
  readonly mode: number;
  readonly mtimeNanoseconds: string;
  readonly fileSha256: string;
  readonly semanticSha256: string;
}

export async function captureFileIdentity(
  path: string,
  root: string,
): Promise<FileIdentity> {
  const target = await validateOwnedPath(path, root);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [stats, bytes] = await Promise.all([
      handle.stat({ bigint: true }),
      handle.readFile(),
    ]);
    if (
      !stats.isFile() ||
      stats.nlink !== 1n ||
      stats.uid !== BigInt(process.getuid?.() ?? -1) ||
      (stats.mode & 0o777n) !== 0o600n
    )
      throw new Error(
        "State identity requires a protected regular unlinked file",
      );
    const text = bytes.toString("utf8");
    const semantic = canonicalJson(JSON.parse(text) as unknown);
    return {
      size: Number(stats.size),
      mode: Number(stats.mode & 0o777n),
      mtimeNanoseconds: stats.mtimeNs.toString(),
      fileSha256: createHash("sha256").update(bytes).digest("hex"),
      semanticSha256: createHash("sha256").update(semantic).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

export async function identityStillMatches(
  path: string,
  root: string,
  expected: FileIdentity,
): Promise<boolean> {
  try {
    const current = await captureFileIdentity(path, root);
    return (
      current.fileSha256 === expected.fileSha256 &&
      current.mtimeNanoseconds === expected.mtimeNanoseconds
    );
  } catch {
    return false;
  }
}
