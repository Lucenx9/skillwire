import { resolve } from "node:path";

import {
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "../process/command-runner.js";

export interface ServiceDatabaseOptions {
  readonly dockerExecutable: string;
  readonly projectName: string;
  readonly volumeName: string;
  readonly composePath: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly run?:
    ((options: CommandOptions) => Promise<CommandResult>) | undefined;
}

export class ServiceDatabase {
  private readonly run: (options: CommandOptions) => Promise<CommandResult>;

  public constructor(private readonly options: ServiceDatabaseOptions) {
    if (options.volumeName !== `${options.projectName}_postgres_data`)
      throw new Error("PostgreSQL volume identity is not stable");
    this.run = options.run ?? runCommand;
  }

  private command(args: readonly string[]): Promise<CommandResult> {
    return this.run({
      executable: resolve(this.options.dockerExecutable),
      args,
      environment: {
        ...this.options.environment,
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
      },
      deadlineMilliseconds: 15_000,
      maximumOutputBytes: 64 * 1024,
    });
  }

  async verifyVolume(): Promise<void> {
    const result = await this.command([
      "volume",
      "inspect",
      this.options.volumeName,
      "--format",
      "{{.Name}}",
    ]);
    if (result.stdout.trim() !== this.options.volumeName)
      throw new Error("Stable PostgreSQL volume is unavailable");
  }

  async verifySchemaAndReadiness(): Promise<{
    version: string;
    latestMigration: string;
  }> {
    const query =
      "SELECT current_setting('server_version'), (SELECT max(version) FROM schema_migrations)";
    const result = await this.command([
      "compose",
      "--project-name",
      this.options.projectName,
      "--file",
      this.options.composePath,
      "exec",
      "-T",
      "postgres",
      "psql",
      "--username",
      "skillwire",
      "--dbname",
      "skillwire",
      "--tuples-only",
      "--no-align",
      "--command",
      query,
    ]);
    const [version, latestMigration] = result.stdout.trim().split("|");
    if (
      version === undefined ||
      !version.startsWith("17.") ||
      latestMigration !== "010"
    )
      throw new Error("PostgreSQL 17/migration 010 readiness gate failed");
    return { version, latestMigration };
  }
}
