import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import {
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "../process/command-runner.js";
import {
  validateOwnedDirectory,
  validateOwnedPath,
} from "../filesystem/safe-paths.js";
import {
  assertLocalDockerContext,
  dockerProcessEnvironment,
  pinLocalDockerEndpoint,
} from "../docker/environment.js";
import type { RestoredDatabaseValidation } from "./restore-validation.js";

export type { RestoredDatabaseValidation } from "./restore-validation.js";

const COMPOSE_KEYS = [
  "SKILLWIRE_COMPOSE_PROJECT",
  "SKILLWIRE_POSTGRES_VOLUME",
  "SKILLWIRE_IMAGE",
  "SKILLWIRE_POSTGRES_IMAGE",
  "SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE",
  "SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE",
  "SKILLWIRE_RUNTIME_SOCKET_DIRECTORY",
  "SKILLWIRE_RUNTIME_UID",
  "SKILLWIRE_RUNTIME_GID",
] as const;

export interface PostgresBackupOptions {
  readonly dockerExecutable: string;
  readonly composePath: string;
  readonly projectName: string;
  readonly installationId: string;
  readonly protectedRoot: string;
  readonly backupsRoot: string;
  readonly postgresImage: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly expectedLatestMigration?: string | undefined;
  readonly run?:
    ((options: CommandOptions) => Promise<CommandResult>) | undefined;
  readonly validateRestoredDatabase: (
    containerName: string,
    signal: AbortSignal,
  ) => Promise<RestoredDatabaseValidation>;
}

export interface ValidatedPostgresBackup {
  readonly backupId: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly validation: RestoredDatabaseValidation;
}

export class PostgresBackupAdapter {
  private readonly run: (options: CommandOptions) => Promise<CommandResult>;

  public constructor(private readonly options: PostgresBackupOptions) {
    if (!/^skillwire-[a-z0-9-]+$/.test(options.projectName))
      throw new Error("Backup project identity is invalid");
    if (
      !/^docker\.io\/library\/postgres@sha256:[0-9a-f]{64}$/.test(
        options.postgresImage,
      )
    )
      throw new Error("Backup restore image must be digest-pinned PostgreSQL");
    const backupRelative = relative(
      resolve(options.protectedRoot),
      resolve(options.backupsRoot),
    );
    if (
      backupRelative === "" ||
      backupRelative.startsWith("..") ||
      isAbsolute(backupRelative)
    )
      throw new Error("Backup directory must be below its protected root");
    this.run = options.run ?? runCommand;
  }

  private command(
    args: readonly string[],
    signal: AbortSignal,
    deadlineMilliseconds = 120_000,
    ambient: NodeJS.ProcessEnv = this.options.environment ?? {},
  ): Promise<CommandResult> {
    const explicit: Record<string, string> = {};
    for (const key of COMPOSE_KEYS) {
      const value = ambient[key];
      if (value !== undefined) explicit[key] = value;
    }
    return this.run({
      executable: resolve(this.options.dockerExecutable),
      args,
      environment: dockerProcessEnvironment(ambient, explicit),
      deadlineMilliseconds,
      maximumOutputBytes: 128 * 1024,
      signal,
    });
  }

  private async waitForValidationDatabase(
    containerName: string,
    signal: AbortSignal,
    environment: NodeJS.ProcessEnv,
  ): Promise<void> {
    let lastError: unknown;
    let consecutiveReadyChecks = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (signal.aborted) throw new Error("Backup validation cancelled");
      try {
        await this.command(
          [
            "exec",
            containerName,
            "pg_isready",
            "--username=postgres",
            "--dbname=postgres",
          ],
          signal,
          2_000,
          environment,
        );
        consecutiveReadyChecks += 1;
        if (consecutiveReadyChecks >= 2) return;
      } catch (error) {
        lastError = error;
        consecutiveReadyChecks = 0;
      }
      await new Promise<void>((done) => {
        setTimeout(done, 250);
      });
    }
    throw new Error("Isolated PostgreSQL restore target did not become ready", {
      cause: lastError,
    });
  }

  async createAndValidate(
    signal: AbortSignal,
  ): Promise<ValidatedPostgresBackup> {
    if (signal.aborted) throw new Error("Backup cancelled");
    const backupId = randomUUID();
    const protectedRoot = resolve(this.options.protectedRoot);
    await validateOwnedDirectory(protectedRoot, protectedRoot);
    const root = await validateOwnedPath(
      resolve(this.options.backupsRoot),
      protectedRoot,
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    await validateOwnedDirectory(root, protectedRoot);
    const backupRoot = await validateOwnedPath(resolve(root, backupId), root);
    await mkdir(backupRoot, { mode: 0o700 });
    await validateOwnedDirectory(backupRoot, root);
    const archivePath = await validateOwnedPath(
      resolve(backupRoot, "database.dump"),
      backupRoot,
    );
    const containerArchive = `/tmp/skillwire-${backupId}.dump`;
    const compose = [
      "compose",
      "--project-name",
      this.options.projectName,
      "--file",
      resolve(this.options.composePath),
    ];
    try {
      const endpoint = await assertLocalDockerContext({
        dockerExecutable: this.options.dockerExecutable,
        environment: this.options.environment ?? {},
        signal,
        run: this.run,
      });
      const operationEnvironment = pinLocalDockerEndpoint(
        this.options.environment ?? {},
        endpoint,
      );
      await this.command(
        [
          ...compose,
          "exec",
          "-T",
          "postgres",
          "pg_dump",
          "--username=skillwire",
          "--dbname=skillwire",
          "--format=custom",
          "--no-owner",
          "--no-acl",
          `--file=${containerArchive}`,
        ],
        signal,
        120_000,
        operationEnvironment,
      );
      try {
        await this.command(
          [...compose, "cp", `postgres:${containerArchive}`, archivePath],
          signal,
          120_000,
          operationEnvironment,
        );
      } finally {
        await this.command(
          [...compose, "exec", "-T", "postgres", "rm", "-f", containerArchive],
          AbortSignal.timeout(30_000),
          120_000,
          operationEnvironment,
        ).catch(() => undefined);
      }
      await chmod(archivePath, 0o600);
      const handle = await open(
        archivePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let archiveSha256: string;
      try {
        const stats = await handle.stat();
        if (
          !stats.isFile() ||
          stats.nlink !== 1 ||
          stats.uid !== process.getuid?.() ||
          (stats.mode & 0o777) !== 0o600 ||
          stats.size < 8 ||
          stats.size > 16 * 1024 * 1024 * 1024
        )
          throw new Error("Backup archive is unsafe or invalid");
        const digest = createHash("sha256");
        for await (const chunk of handle.createReadStream({
          autoClose: false,
        }) as AsyncIterable<Buffer>)
          digest.update(chunk);
        archiveSha256 = digest.digest("hex");
      } finally {
        await handle.close();
      }

      const suffix = backupId.replaceAll("-", "").slice(0, 16);
      const validationContainer = `skillwire-backup-validate-${suffix}`;
      const validationVolume = `${validationContainer}_data`;
      let validation: RestoredDatabaseValidation | undefined;
      try {
        await this.command(
          ["volume", "create", validationVolume],
          signal,
          120_000,
          operationEnvironment,
        );
        await this.command(
          [
            "run",
            "--detach",
            "--name",
            validationContainer,
            "--network",
            "none",
            "--mount",
            `type=volume,source=${validationVolume},target=/var/lib/postgresql/data`,
            "--env",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            this.options.postgresImage,
          ],
          signal,
          120_000,
          operationEnvironment,
        );
        await this.waitForValidationDatabase(
          validationContainer,
          signal,
          operationEnvironment,
        );
        await this.command(
          [
            "cp",
            archivePath,
            `${validationContainer}:/tmp/${basename(archivePath)}`,
          ],
          signal,
          120_000,
          operationEnvironment,
        );
        await this.command(
          [
            "exec",
            validationContainer,
            "pg_restore",
            "--exit-on-error",
            "--single-transaction",
            "--no-owner",
            "--no-acl",
            "--username=postgres",
            "--dbname=postgres",
            `/tmp/${basename(archivePath)}`,
          ],
          signal,
          120_000,
          operationEnvironment,
        );
        validation = await this.options.validateRestoredDatabase(
          validationContainer,
          signal,
        );
        if (
          validation.latestMigration !==
            (this.options.expectedLatestMigration ?? "010") ||
          !validation.migrationInventoryValid ||
          !validation.constraintsValid ||
          !validation.catalogValid ||
          !validation.advisoryValid ||
          !validation.authoritativeStateValid ||
          !validation.ready
        )
          throw new Error("Restored backup did not pass readiness invariants");
      } catch (error) {
        throw new Error("Backup archive restore validation failed", {
          cause: error,
        });
      } finally {
        const cleanupSignal = AbortSignal.timeout(30_000);
        await this.command(
          ["container", "rm", "--force", validationContainer],
          cleanupSignal,
          120_000,
          operationEnvironment,
        ).catch(() => undefined);
        await this.command(
          ["volume", "rm", validationVolume],
          cleanupSignal,
          120_000,
          operationEnvironment,
        ).catch(() => undefined);
      }
      return { backupId, archivePath, archiveSha256, validation };
    } catch (error) {
      try {
        await validateOwnedDirectory(backupRoot, root);
        await rm(backupRoot, { recursive: true });
      } catch (cleanupError) {
        throw new Error(
          "Incomplete backup cleanup requires exact filesystem recovery",
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }
}
