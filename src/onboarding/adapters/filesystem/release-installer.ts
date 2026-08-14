import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type { ReleaseManifest } from "../../domain/release-manifest.js";
import type { OperationJournal } from "../../domain/operation-journal.js";
import { OwnershipProofSchema } from "../../domain/ownership.js";
import { atomicWriteJson } from "./atomic-state.js";
import { validateOwnedDirectory, validateOwnedPath } from "./safe-paths.js";
import { runCommand } from "../process/command-runner.js";

export interface InstallReleaseOptions {
  readonly archivePath: string;
  readonly manifest: ReleaseManifest;
  readonly dataRoot: string;
  readonly stateRoot: string;
  readonly launcherRoot: string;
  readonly launcherPath: string;
  readonly installationId: string;
  readonly manifestSha256: string;
  readonly trustPolicyPath: string;
  readonly tarExecutable?: string | undefined;
  readonly activate?: boolean | undefined;
}

export interface InstalledReleasePaths {
  readonly changed: boolean;
  readonly releaseRoot: string;
  readonly launcherPath: string;
  readonly ownershipPath: string;
}

async function ensureUserDirectory(path: string, root: string): Promise<void> {
  const target = await validateOwnedPath(path, root);
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
  const stats = await lstat(target);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== process.getuid?.() ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error("Launcher directory is not a safe user-owned directory");
  }
}

function safeArchiveListing(names: string, verbose: string): void {
  const entries = names.split("\n").filter(Boolean);
  const verboseEntries = verbose.split("\n").filter(Boolean);
  if (entries.length < 1 || entries.length > 8192)
    throw new Error("Release archive inventory is empty or too large");
  if (entries.length !== verboseEntries.length)
    throw new Error("Release archive listings disagree");
  entries.forEach((raw, index) => {
    const type = verboseEntries[index]?.[0];
    if (type !== "-" && type !== "d") {
      throw new Error("Release archive contains a link or special entry");
    }
    if (!/^[A-Za-z0-9@+_,=./-]+\/?$/.test(raw))
      throw new Error("Release archive listing is invalid");
    const unprefixed = raw.startsWith("./") ? raw.slice(2) : raw;
    const path = unprefixed.endsWith("/")
      ? unprefixed.slice(0, -1)
      : unprefixed;
    if ((path === "" || path === ".") && type === "d") return;
    if (
      path.startsWith("/") ||
      path.split("/").some((segment) => segment === ".." || segment === "") ||
      path.includes("\0")
    )
      throw new Error("Release archive contains an unsafe path");
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function extractedInventory(
  root: string,
): Promise<ReleaseManifest["payload"]> {
  const result: ReleaseManifest["payload"][number][] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).toSorted()) {
      const path = join(directory, name);
      const stats = await lstat(path);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await visit(path);
        continue;
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
        throw new Error("Extracted release contains a link or special file");
      const bytes = await readFile(path);
      result.push({
        path: relative(root, path).split(sep).join("/"),
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mode: (stats.mode & 0o777).toString(8).padStart(4, "0") as
          "0600" | "0644" | "0700" | "0755",
      });
    }
  }
  await visit(root);
  return result;
}

export async function releaseDirectoryIdentity(root: string): Promise<string> {
  return createHash("sha256")
    .update("skillwire-release-directory-v1\0")
    .update(JSON.stringify(await extractedInventory(resolve(root))))
    .digest("hex");
}

async function persistTrustPolicy(
  sourcePath: string,
  manifest: ReleaseManifest,
  dataRoot: string,
): Promise<string> {
  const source = await open(
    resolve(sourcePath),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let bytes: Buffer;
  try {
    const stats = await source.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.size !== manifest.trustPolicy.size ||
      stats.size > 1024 * 1024
    ) {
      throw new Error("Verified trust policy source is unsafe");
    }
    bytes = await source.readFile();
  } finally {
    await source.close();
  }
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    manifest.trustPolicy.sha256
  )
    throw new Error("Verified trust policy changed before persistence");

  const trustRoot = resolve(dataRoot, "trust");
  await mkdir(trustRoot, { mode: 0o700 }).catch((error: unknown) => {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
  });
  await validateOwnedDirectory(trustRoot, dataRoot);
  const target = await validateOwnedPath(
    resolve(trustRoot, manifest.trustPolicy.path),
    trustRoot,
  );
  try {
    const existing = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stats = await existing.stat();
      const current = await existing.readFile();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o600 ||
        !current.equals(bytes)
      ) {
        throw new Error("Persisted trust policy identity has drifted");
      }
    } finally {
      await existing.close();
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    const targetHandle = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await targetHandle.writeFile(bytes);
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }
  }
  return `trust/${manifest.trustPolicy.path}`;
}

async function stageVerifiedArchive(
  sourcePath: string,
  manifest: ReleaseManifest,
  releasesRoot: string,
): Promise<string> {
  const source = await open(
    resolve(sourcePath),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const stagedPath = resolve(
    releasesRoot,
    `.archive-${randomBytes(12).toString("hex")}`,
  );
  let target;
  try {
    const before = await source.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(manifest.archive.size) ||
      before.size > 16n * 1024n ** 3n
    ) {
      throw new Error("Verified release archive identity changed");
    }
    target = await open(
      stagedPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const digest = createHash("sha256");
    for await (const chunk of source.createReadStream({
      autoClose: false,
    }) as AsyncIterable<Buffer>) {
      digest.update(chunk);
      await target.write(chunk);
    }
    await target.sync();
    const after = await source.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      digest.digest("hex") !== manifest.archive.sha256
    ) {
      throw new Error("Verified release archive identity changed");
    }
    return stagedPath;
  } catch (error) {
    await rm(stagedPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await target?.close();
    await source.close();
  }
}

export async function installVerifiedRelease(
  options: InstallReleaseOptions,
): Promise<InstalledReleasePaths> {
  const dataRoot = resolve(options.dataRoot);
  const stateRoot = resolve(options.stateRoot);
  const launcherRoot = resolve(options.launcherRoot);
  const launcherPath = await validateOwnedPath(
    resolve(options.launcherPath),
    launcherRoot,
  );
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await validateOwnedDirectory(dataRoot, dataRoot);
  await validateOwnedDirectory(stateRoot, stateRoot);
  const releasesRoot = resolve(dataRoot, "releases");
  const ownershipRoot = resolve(stateRoot, "ownership");
  for (const path of [releasesRoot, ownershipRoot]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await validateOwnedDirectory(
      path,
      path === releasesRoot ? dataRoot : stateRoot,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(options.manifestSha256))
    throw new Error("Verified manifest identity is invalid");
  const trustPolicyPath = await persistTrustPolicy(
    options.trustPolicyPath,
    options.manifest,
    dataRoot,
  );
  await ensureUserDirectory(launcherRoot, launcherRoot);
  const localRoot = resolve(launcherRoot, ".local");
  const binRoot = resolve(localRoot, "bin");
  await ensureUserDirectory(localRoot, launcherRoot);
  await ensureUserDirectory(binRoot, launcherRoot);
  if (resolve(launcherPath) !== resolve(binRoot, "skillwire")) {
    throw new Error("Stable launcher must be ~/.local/bin/skillwire");
  }
  const releaseRoot = resolve(
    releasesRoot,
    `skillwire-${options.manifest.releaseVersion}-linux-${options.manifest.architecture}`,
  );
  const ownershipPath = resolve(
    ownershipRoot,
    `release-${String(options.manifest.releaseSequence)}.json`,
  );
  let releaseChanged = true;
  try {
    const existing = await lstat(releaseRoot);
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      const actual = await extractedInventory(releaseRoot);
      if (JSON.stringify(actual) !== JSON.stringify(options.manifest.payload)) {
        throw new Error("Immutable release path has drifted");
      }
      releaseChanged = false;
    } else {
      throw new Error("Immutable release path is not a directory");
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  if (releaseChanged) {
    const stage = resolve(
      releasesRoot,
      `.stage-${randomBytes(12).toString("hex")}`,
    );
    await mkdir(stage, { mode: 0o700 });
    const tar = options.tarExecutable ?? "/usr/bin/tar";
    let pinnedArchive: string | undefined;
    try {
      pinnedArchive = await stageVerifiedArchive(
        options.archivePath,
        options.manifest,
        releasesRoot,
      );
      const listed = await runCommand({
        executable: tar,
        args: [
          "--use-compress-program=/usr/bin/zstd",
          "--quoting-style=escape",
          "-tf",
          pinnedArchive,
        ],
        environment: { PATH: "/usr/bin:/bin", LANG: "C" },
        deadlineMilliseconds: 30_000,
      });
      const verbose = await runCommand({
        executable: tar,
        args: [
          "--use-compress-program=/usr/bin/zstd",
          "--quoting-style=escape",
          "-tvf",
          pinnedArchive,
        ],
        environment: { PATH: "/usr/bin:/bin", LANG: "C" },
        deadlineMilliseconds: 30_000,
      });
      safeArchiveListing(listed.stdout, verbose.stdout);
      await runCommand({
        executable: tar,
        args: [
          "--use-compress-program=/usr/bin/zstd",
          "--no-same-owner",
          "--no-same-permissions",
          "-xf",
          pinnedArchive,
          "-C",
          stage,
        ],
        environment: { PATH: "/usr/bin:/bin", LANG: "C" },
        deadlineMilliseconds: 60_000,
      });
      const actual = await extractedInventory(stage);
      if (JSON.stringify(actual) !== JSON.stringify(options.manifest.payload))
        throw new Error(
          "Extracted release inventory does not match its verified manifest",
        );
      await rename(stage, releaseRoot);
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    } finally {
      if (pinnedArchive !== undefined) await rm(pinnedArchive, { force: true });
    }
  }
  await validateOwnedPath(resolve(releaseRoot, "bin/skillwire"), releaseRoot);
  const launcher = [
    "#!/bin/sh",
    "set -eu",
    `export SKILLWIRE_RELEASE_ROOT=${shellQuote(releaseRoot)}`,
    `exec ${shellQuote(resolve(releaseRoot, "runtime/node"))} ${shellQuote(resolve(releaseRoot, "app/skillwire.mjs"))} "$@"`,
    "",
  ].join("\n");
  let launcherChanged = true;
  try {
    const launcherHandle = await open(
      launcherPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stats = await launcherHandle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o700 ||
        (await launcherHandle.readFile("utf8")) !== launcher
      ) {
        throw new Error(
          "Existing stable launcher is not the expected owned launcher",
        );
      }
      launcherChanged = false;
    } finally {
      await launcherHandle.close();
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
  if (launcherChanged) {
    const launcherStage = resolve(
      binRoot,
      `.skillwire-${randomBytes(8).toString("hex")}.stage`,
    );
    const launcherHandle = await open(
      launcherStage,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o700,
    );
    try {
      await launcherHandle.writeFile(launcher, "utf8");
      await launcherHandle.sync();
    } finally {
      await launcherHandle.close();
    }
    await rename(launcherStage, launcherPath);
    await chmod(launcherPath, 0o700);
  }
  if (options.activate !== false)
    await atomicWriteJson(
      resolve(stateRoot, "active-release.json"),
      {
        schemaVersion: "skillwire.active-release/v1",
        releaseVersion: options.manifest.releaseVersion,
        releaseSequence: options.manifest.releaseSequence,
        trustPolicySequence: options.manifest.trustPolicySequence,
        architecture: options.manifest.architecture,
        manifestSha256: options.manifestSha256,
        archiveSha256: options.manifest.archive.sha256,
        trustPolicyPath,
      },
      stateRoot,
    );
  await atomicWriteJson(
    ownershipPath,
    OwnershipProofSchema.parse({
      schemaVersion: "skillwire.ownership/v1",
      assetId: `release:${String(options.manifest.releaseSequence)}`,
      kind: "release",
      identitySha256: options.manifest.archive.sha256,
      createdByOperation: randomUUID(),
      installationId: options.installationId,
    }),
    stateRoot,
  );
  return {
    changed: releaseChanged || launcherChanged,
    releaseRoot,
    launcherPath,
    ownershipPath,
  };
}

export interface ActiveReleaseSelection {
  readonly schemaVersion: "skillwire.active-release/v1";
  readonly releaseVersion: string;
  readonly releaseSequence: number;
  readonly trustPolicySequence: number;
  readonly architecture: "amd64" | "arm64";
  readonly manifestSha256: string;
  readonly archiveSha256: string;
  readonly trustPolicyPath: string;
}

export async function commitActiveReleaseSelection(options: {
  readonly stateRoot: string;
  readonly selection: ActiveReleaseSelection;
  readonly journal: OperationJournal;
  readonly signal: AbortSignal;
}): Promise<void> {
  await options.journal.runEffect({
    step: "active-release-selection",
    intent: {
      releaseSequence: options.selection.releaseSequence,
      trustPolicySequence: options.selection.trustPolicySequence,
      manifestSha256: options.selection.manifestSha256,
    },
    signal: options.signal,
    action: () =>
      atomicWriteJson(
        resolve(options.stateRoot, "active-release.json"),
        options.selection,
        options.stateRoot,
      ),
    verification: () => ({
      releaseSequence: options.selection.releaseSequence,
      selected: true,
    }),
  });
}
