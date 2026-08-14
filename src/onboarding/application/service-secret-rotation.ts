import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import {
  validateOwnedDirectory,
  validateOwnedPath,
} from "../adapters/filesystem/safe-paths.js";
import { canonicalPreview, confirmPreview } from "../cli/confirmation.js";
import type { ServiceSecretKind } from "../secrets/service-secrets.js";
import type { OperationJournal } from "../domain/operation-journal.js";

export interface ServiceSecretRotationPreview {
  readonly operationId: string;
  readonly installationId: string;
  readonly kind: ServiceSecretKind;
  readonly targets: readonly [string, string];
  readonly previewHash: string;
  readonly currentIdentitySha256: string;
}

function deterministicOperationId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function previewServiceSecretRotation(input: {
  readonly installationId: string;
  readonly kind: ServiceSecretKind;
  readonly currentIdentitySha256: string;
}): ServiceSecretRotationPreview {
  const operationId = deterministicOperationId(
    `${input.installationId}\0${input.kind}\0${input.currentIdentitySha256}`,
  );
  const targets = [
    `secrets/${input.kind}`,
    `secrets/${input.kind}.retained-${operationId}`,
  ] as const;
  const scope = {
    installationId: input.installationId,
    kind: input.kind,
    operationId,
    targets,
    currentIdentitySha256: input.currentIdentitySha256,
  };
  return {
    ...scope,
    previewHash: canonicalPreview("maintenance:rotate-service-secret", scope)
      .hash,
  };
}

async function validateSecret(path: string, root: string): Promise<string> {
  const target = await validateOwnedPath(path, root);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size !== 43
    ) {
      throw new Error("Service-secret rotation target is unsafe");
    }
    const bytes = await handle.readFile();
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(bytes.toString("ascii")))
        throw new Error("Service-secret rotation target has an invalid format");
      return createHash("sha256")
        .update("skillwire-service-secret-identity-v1\0")
        .update(bytes)
        .digest("hex");
    } finally {
      bytes.fill(0);
    }
  } finally {
    await handle.close();
  }
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

async function requirePathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  throw new Error("Service-secret rotation retained target already exists");
}

export async function rotateServiceSecret(options: {
  readonly installationRoot: string;
  readonly stateRoot: string;
  readonly kind: ServiceSecretKind;
  readonly confirmation: string | undefined;
  readonly preview: ServiceSecretRotationPreview;
  readonly signal: AbortSignal;
  readonly apply: (path: string) => Promise<void>;
  readonly readiness: () => Promise<void>;
  readonly publish: (reference: {
    readonly kind: ServiceSecretKind;
    readonly identitySha256: string;
  }) => Promise<void>;
  readonly rollback?: ((path: string) => Promise<void>) | undefined;
  readonly journal?: OperationJournal | undefined;
}): Promise<{
  readonly operationId: string;
  readonly kind: ServiceSecretKind;
  readonly retainedPath: string;
  readonly identitySha256: string;
}> {
  if (options.preview.kind !== options.kind)
    throw new Error("Service-secret rotation preview changed");
  confirmPreview(
    {
      command: "maintenance:rotate-service-secret",
      json: "",
      hash: options.preview.previewHash,
    },
    options.confirmation,
  );
  if (options.signal.aborted)
    throw new Error("Service-secret rotation cancelled");
  const installationRoot = await validateOwnedPath(
    options.installationRoot,
    options.stateRoot,
  );
  const secretsRoot = resolve(installationRoot, "secrets");
  await validateOwnedDirectory(secretsRoot, installationRoot);
  const currentPath = resolve(secretsRoot, options.kind);
  const retainedPath = resolve(
    secretsRoot,
    `${options.kind}.retained-${options.preview.operationId}`,
  );
  const candidatePath = resolve(
    secretsRoot,
    `${options.kind}.candidate-${options.preview.operationId}`,
  );
  const currentIdentitySha256 = await validateSecret(
    currentPath,
    installationRoot,
  );
  if (currentIdentitySha256 !== options.preview.currentIdentitySha256)
    throw new Error("Service-secret rotation target identity changed");
  await requirePathAbsent(retainedPath);
  const candidate = Buffer.from(randomBytes(32).toString("base64url"), "ascii");
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
  const ownedCandidatePaths = new Set<string>();
  try {
    await effect(
      "service-secret-candidate",
      async () => {
        const candidateHandle = await open(
          candidatePath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        ownedCandidatePaths.add(candidatePath);
        try {
          await candidateHandle.writeFile(candidate);
          await candidateHandle.sync();
        } catch (error) {
          await unlink(candidatePath).catch(() => undefined);
          ownedCandidatePaths.delete(candidatePath);
          throw error;
        } finally {
          await candidateHandle.close();
        }
      },
      { kind: options.kind },
    );
  } catch (error) {
    candidate.fill(0);
    if (ownedCandidatePaths.delete(candidatePath))
      await unlink(candidatePath).catch(() => undefined);
    throw error;
  }
  const identitySha256 = createHash("sha256")
    .update("skillwire-service-secret-identity-v1\0")
    .update(candidate)
    .digest("hex");
  candidate.fill(0);
  const rotationState: { retainedLinked: boolean; swapped: boolean } = {
    retainedLinked: false,
    swapped: false,
  };
  try {
    await effect(
      "service-secret-candidate-readiness",
      async () => {
        await options.apply(candidatePath);
        if (options.signal.aborted)
          throw new Error("Service-secret rotation cancelled before readiness");
        await options.readiness();
      },
      { kind: options.kind },
    );
    await effect(
      "service-secret-atomic-swap",
      async () => {
        await link(currentPath, retainedPath);
        rotationState.retainedLinked = true;
        try {
          await rename(candidatePath, currentPath);
          rotationState.swapped = true;
          await syncDirectory(secretsRoot);
        } catch (error) {
          if (rotationState.swapped) {
            await rename(currentPath, candidatePath);
            rotationState.swapped = false;
          }
          await unlink(retainedPath);
          rotationState.retainedLinked = false;
          await syncDirectory(secretsRoot);
          throw error;
        }
      },
      { kind: options.kind },
    );
    await effect(
      "service-secret-active-readiness",
      async () => {
        await options.apply(currentPath);
        await options.readiness();
      },
      { kind: options.kind },
    );
    await effect(
      "service-secret-state-publication",
      () => options.publish({ kind: options.kind, identitySha256 }),
      { kind: options.kind, identitySha256 },
    );
    return {
      operationId: options.preview.operationId,
      kind: options.kind,
      retainedPath,
      identitySha256,
    };
  } catch (error) {
    try {
      if (rotationState.swapped) {
        await rename(currentPath, candidatePath);
        await rename(retainedPath, currentPath);
        rotationState.swapped = false;
        rotationState.retainedLinked = false;
        await syncDirectory(secretsRoot);
      }
      await options.rollback?.(currentPath);
      await unlink(candidatePath).catch((cleanupError: unknown) => {
        if (
          !(cleanupError instanceof Error) ||
          !("code" in cleanupError) ||
          cleanupError.code !== "ENOENT"
        )
          throw cleanupError;
      });
      await options.journal?.compensate("service-secret-rollback", {
        kind: options.kind,
        restored: true,
      });
    } catch (rollbackError) {
      throw new Error(
        "Service-secret rotation failed and application rollback requires recovery",
        { cause: rollbackError },
      );
    }
    throw new Error("Service-secret rotation failed before readiness commit", {
      cause: error,
    });
  }
}
