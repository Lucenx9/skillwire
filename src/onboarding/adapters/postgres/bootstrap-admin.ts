import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { parseApiKeyToken } from "../../../authentication/api-key-token.js";
import { runCommand } from "../process/command-runner.js";
import type { ClientName } from "../../cli/main.js";
import { PrivateTokenChannel } from "./private-token-channel.js";

export function bootstrapAdminArguments(options: {
  readonly composePath: string;
  readonly projectName: string;
  readonly privateDirectory: string;
  readonly accountId: string;
  readonly keyId: string;
  readonly containerUser: string;
  readonly databasePasswordFile: string;
  readonly applicationPepperFile: string;
}): string[] {
  if (!/^\d+:\d+$/.test(options.containerUser)) {
    throw new Error("Administration container user is invalid");
  }
  return [
    "compose",
    "--project-name",
    options.projectName,
    "--file",
    options.composePath,
    "run",
    "--rm",
    "--no-TTY",
    "--no-deps",
    "--user",
    options.containerUser,
    "--entrypoint",
    "node",
    ...adminSecretMountArguments(options),
    "--volume",
    `${options.privateDirectory}:/run/skillwire-private:rw`,
    "admin",
    "dist/src/authentication/admin-cli.js",
    "key:create",
    "--account-id",
    options.accountId,
    "--key-id",
    options.keyId,
    "--token-output",
    "/run/skillwire-private/token",
  ];
}

export function bootstrapAccountArguments(options: {
  readonly composePath: string;
  readonly projectName: string;
  readonly containerUser: string;
  readonly databasePasswordFile: string;
  readonly applicationPepperFile: string;
}): string[] {
  if (!/^\d+:\d+$/.test(options.containerUser)) {
    throw new Error("Administration container user is invalid");
  }
  return [
    "compose",
    "--project-name",
    options.projectName,
    "--file",
    options.composePath,
    "run",
    "--rm",
    "--no-TTY",
    "--no-deps",
    "--user",
    options.containerUser,
    ...adminSecretMountArguments(options),
    "admin",
    "account:create",
  ];
}

function adminSecretMountArguments(options: {
  readonly databasePasswordFile: string;
  readonly applicationPepperFile: string;
}): string[] {
  for (const path of [
    options.databasePasswordFile,
    options.applicationPepperFile,
  ]) {
    if (!isAbsolute(path) || path.includes(":") || /[\0\r\n]/.test(path)) {
      throw new Error("Administration secret file path is invalid");
    }
  }
  return [
    "--volume",
    `${options.databasePasswordFile}:/run/skillwire-admin/database-password:ro`,
    "--volume",
    `${options.applicationPepperFile}:/run/skillwire-admin/application-pepper:ro`,
    "--env",
    "SKILLWIRE_DATABASE_PASSWORD_FILE=/run/skillwire-admin/database-password",
    "--env",
    "SKILLWIRE_API_KEY_PEPPER_FILE=/run/skillwire-admin/application-pepper",
  ];
}

function secretFilePaths(environment: NodeJS.ProcessEnv): {
  readonly databasePasswordFile: string;
  readonly applicationPepperFile: string;
} {
  const databasePasswordFile =
    environment["SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE"];
  const applicationPepperFile =
    environment["SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE"];
  if (
    databasePasswordFile === undefined ||
    applicationPepperFile === undefined
  ) {
    throw new Error("Administration secret file references are unavailable");
  }
  return { databasePasswordFile, applicationPepperFile };
}

function currentContainerUser(): string {
  return [process.getuid?.() ?? 10001, process.getgid?.() ?? 10001]
    .map(String)
    .join(":");
}

export async function createAccountInAdminContainer(options: {
  readonly dockerExecutable: string;
  readonly composePath: string;
  readonly projectName: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal | undefined;
}): Promise<string> {
  const secretFiles = secretFilePaths(options.environment);
  const result = await runCommand({
    executable: resolve(options.dockerExecutable),
    args: bootstrapAccountArguments({
      composePath: options.composePath,
      projectName: options.projectName,
      containerUser: currentContainerUser(),
      ...secretFiles,
    }),
    environment: options.environment,
    deadlineMilliseconds: 30_000,
    maximumOutputBytes: 16 * 1024,
    signal: options.signal,
  });
  const metadata = z
    .object({ accountId: z.uuid() })
    .strict()
    .parse(JSON.parse(result.stdout) as unknown);
  return metadata.accountId;
}

export async function revokeClientKeyInAdminContainer(options: {
  readonly dockerExecutable: string;
  readonly composePath: string;
  readonly projectName: string;
  readonly keyId: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal | undefined;
}): Promise<void> {
  if (!z.uuid().safeParse(options.keyId).success) {
    throw new Error("Client key identity is invalid");
  }
  const result = await runCommand({
    executable: resolve(options.dockerExecutable),
    args: [
      "compose",
      "--project-name",
      options.projectName,
      "--file",
      options.composePath,
      "run",
      "--rm",
      "--no-TTY",
      "--no-deps",
      "--user",
      currentContainerUser(),
      "admin",
      "key:revoke",
      "--key-id",
      options.keyId,
    ],
    environment: options.environment,
    deadlineMilliseconds: 30_000,
    maximumOutputBytes: 16 * 1024,
    signal: options.signal,
  });
  z.object({ revoked: z.literal(true) })
    .strict()
    .parse(JSON.parse(result.stdout) as unknown);
}

export interface BootstrappedClientKey {
  readonly client: ClientName;
  readonly keyId: string;
  readonly token: string;
}

export class ClientKeyHandoffRecoveryError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClientKeyHandoffRecoveryError";
  }
}

export async function createClientKeyInAdminContainer(options: {
  readonly client: ClientName;
  readonly dockerExecutable: string;
  readonly composePath: string;
  readonly projectName: string;
  readonly accountId: string;
  readonly runtimeRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal | undefined;
}): Promise<BootstrappedClientKey> {
  const secretFiles = secretFilePaths(options.environment);
  const keyId = randomUUID();
  await mkdir(options.runtimeRoot, { recursive: true, mode: 0o700 });
  const privateDirectory = await mkdtemp(
    resolve(options.runtimeRoot, "admin-key-"),
  );
  const fifo = resolve(privateDirectory, "token");
  let channel: PrivateTokenChannel | undefined;
  try {
    await runCommand({
      executable: "/usr/bin/mkfifo",
      args: ["--mode=0600", fifo],
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      deadlineMilliseconds: 2_000,
      signal: options.signal,
    });
    channel = await PrivateTokenChannel.open(fifo);
    const result = await runCommand({
      executable: resolve(options.dockerExecutable),
      args: bootstrapAdminArguments({
        composePath: options.composePath,
        projectName: options.projectName,
        privateDirectory,
        accountId: options.accountId,
        keyId,
        containerUser: currentContainerUser(),
        ...secretFiles,
      }),
      environment: options.environment,
      deadlineMilliseconds: 30_000,
      maximumOutputBytes: 16 * 1024,
      signal: options.signal,
    });
    const token = await channel.receive();
    if (parseApiKeyToken(token) === undefined)
      throw new Error("Private administration channel returned an invalid key");
    const metadata = z
      .object({
        accountId: z.uuid(),
        keyId: z.uuid(),
        tokenDelivery: z.literal("private-file-descriptor"),
      })
      .strict()
      .parse(JSON.parse(result.stdout) as unknown);
    if (metadata.keyId !== keyId) {
      throw new Error(
        "Administration returned a different client key identity",
      );
    }
    return { client: options.client, keyId: metadata.keyId, token };
  } catch (error) {
    try {
      await revokeClientKeyInAdminContainer({
        dockerExecutable: options.dockerExecutable,
        composePath: options.composePath,
        projectName: options.projectName,
        keyId,
        environment: options.environment,
      });
    } catch (recoveryError) {
      throw new ClientKeyHandoffRecoveryError(
        "Private client key handoff failed and the known key identity could not be revoked",
        { cause: recoveryError },
      );
    }
    throw error;
  } finally {
    await channel?.close().catch(() => undefined);
    await rm(privateDirectory, { recursive: true, force: true });
  }
}
