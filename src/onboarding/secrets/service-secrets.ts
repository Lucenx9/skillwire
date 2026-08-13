import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  validateOwnedDirectory,
  validateOwnedPath,
} from "../adapters/filesystem/safe-paths.js";

export type ServiceSecretKind = "database-password" | "application-pepper";

export interface ServiceSecretReference {
  readonly kind: ServiceSecretKind;
  readonly relativePath: `secrets/${ServiceSecretKind}`;
  readonly identitySha256: string;
  readonly state: "created" | "reused";
}

const kinds: readonly ServiceSecretKind[] = [
  "database-password",
  "application-pepper",
];
const valuePattern = /^[A-Za-z0-9_-]{43}$/;

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function validateOrCreate(
  path: string,
  root: string,
): Promise<{ bytes: Buffer; state: "created" | "reused" }> {
  await validateOwnedPath(path, root);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o600
      ) {
        throw new Error(
          "Existing service secret has unsafe ownership, type, link count, or mode",
        );
      }
      if (stats.size !== 43)
        throw new Error("Existing service secret has an invalid size");
      const bytes = await handle.readFile();
      if (!valuePattern.test(bytes.toString("ascii")))
        throw new Error("Existing service secret has an invalid format");
      return { bytes, state: "reused" };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }

  const bytes = Buffer.from(randomBytes(32).toString("base64url"), "ascii");
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
  return { bytes, state: "created" };
}

export async function ensureServiceSecrets(
  installationRoot: string,
  stateRoot: string,
): Promise<readonly ServiceSecretReference[]> {
  const root = resolve(stateRoot);
  const installation = await validateOwnedPath(installationRoot, root);
  await mkdir(installation, { recursive: true, mode: 0o700 });
  await validateOwnedDirectory(installation, root);
  const secretsRoot = resolve(installation, "secrets");
  await mkdir(secretsRoot, { mode: 0o700 }).catch((error: unknown) => {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
  });
  await validateOwnedDirectory(secretsRoot, installation);

  const references: ServiceSecretReference[] = [];
  for (const kind of kinds) {
    const { bytes, state } = await validateOrCreate(
      resolve(secretsRoot, kind),
      installation,
    );
    references.push({
      kind,
      relativePath: `secrets/${kind}`,
      identitySha256: createHash("sha256")
        .update("skillwire-service-secret-identity-v1\0")
        .update(bytes)
        .digest("hex"),
      state,
    });
  }
  return references;
}
