/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production validation interfaces. */
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createValidatedBackup } from "../../../src/onboarding/application/backup.js";
import { PostgresBackupAdapter } from "../../../src/onboarding/adapters/postgres/backup.js";
import {
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "../../../src/onboarding/adapters/process/command-runner.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

function localDockerContext(
  options: CommandOptions,
): CommandResult | undefined {
  if (options.args[0] !== "context") return undefined;
  return {
    code: 0,
    stdout:
      options.args[1] === "show"
        ? "rootless\n"
        : `${options.environment?.["DOCKER_HOST"] ?? "unix:///run/user/1000/docker.sock"}\n`,
    stderr: "",
    durationMilliseconds: 1,
  };
}

const completeValidation = (latestMigration = "011") => ({
  latestMigration,
  migrationInventoryValid: true,
  constraintsValid: true,
  catalogValid: true,
  advisoryValid: true,
  authoritativeStateValid: true,
  ready: true,
});

describe("restore-validated PostgreSQL backup", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("creates a protected custom dump and validates it through an isolated restore", async () => {
    fixture = await createOnboardingEnvironment();
    const commands: CommandOptions[] = [];
    const run = vi.fn(async (options: CommandOptions) => {
      commands.push(options);
      const context = localDockerContext(options);
      if (context !== undefined) return context;
      if (
        options.args.includes("compose") &&
        options.args.includes("cp") &&
        options.args.at(-1)?.endsWith(".dump")
      ) {
        const target = options.args.at(-1);
        if (target === undefined) throw new Error("missing target");
        await writeFile(target, "PGDMP\0fixture-custom-archive", {
          mode: 0o600,
        });
        await chmod(target, 0o600);
      }
      return { code: 0, stdout: "", stderr: "", durationMilliseconds: 1 };
    });
    const installationId = randomUUID();
    const adapter = new PostgresBackupAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: resolve("distribution/self-hosted/compose.yaml"),
      projectName: "skillwire-test",
      installationId,
      protectedRoot: fixture.root,
      backupsRoot: resolve(fixture.root, "backups"),
      postgresImage: `docker.io/library/postgres@sha256:${"a".repeat(64)}`,
      environment: {
        HOME: fixture.home,
        DOCKER_HOST: `unix://${fixture.runtimeRoot}/docker.sock`,
        GH_TOKEN: "ambient-canary",
      },
      run,
      validateRestoredDatabase: async () => completeValidation(),
    });

    const record = await createValidatedBackup({
      installationId,
      sourceReleaseId: "9-amd64",
      serviceSecretReferences: [
        {
          kind: "database-password",
          relativePath: "secrets/database-password",
          identitySha256: "b".repeat(64),
          state: "reused",
        },
      ],
      clientCredentialReferences: [randomUUID()],
      adapter,
      signal: new AbortController().signal,
    });

    expect(record.status).toBe("validated");
    expect(record.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await lstat(record.archivePath)).mode & 0o777).toBe(0o600);
    const backupRoot = resolve(record.archivePath, "..");
    expect(record.archivePath).toBe(resolve(backupRoot, "database.dump"));
    expect((await readdir(backupRoot)).sort()).toEqual([
      "checksums.json",
      "database.dump",
      "recovery-manifest.json",
      "validation.json",
    ]);
    expect(commands.some(({ args }) => args.includes("--format=custom"))).toBe(
      true,
    );
    const restore = commands.find(({ args }) => args.includes("pg_restore"));
    expect(restore?.args).toEqual(
      expect.arrayContaining([
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-acl",
      ]),
    );
    expect(JSON.stringify(record)).not.toMatch(
      /swk\.|password\s*[=:]|pepper\s*[=:]/i,
    );
    expect(
      commands.every(
        ({ environment }) =>
          !Object.keys(environment ?? {}).some((key) =>
            /TOKEN|SECRET|PASSWORD|PEPPER|CREDENTIAL/i.test(key),
          ),
      ),
    ).toBe(true);
    expect(
      commands.every(
        ({ environment }) =>
          environment?.["DOCKER_HOST"] ===
            `unix://${fixture?.runtimeRoot ?? ""}/docker.sock` &&
          environment["GH_TOKEN"] === undefined,
      ),
    ).toBe(true);
    expect(commands.at(-1)?.args).toEqual(
      expect.arrayContaining(["volume", "rm"]),
    );
  });

  it("rejects an invalid archive and still cleans validation resources", async () => {
    fixture = await createOnboardingEnvironment();
    const commands: CommandOptions[] = [];
    const run = vi.fn(async (options: CommandOptions) => {
      commands.push(options);
      const context = localDockerContext(options);
      if (context !== undefined) return context;
      if (
        options.args.includes("compose") &&
        options.args.includes("cp") &&
        options.args.at(-1)?.endsWith(".dump")
      ) {
        const target = options.args.at(-1);
        if (target !== undefined)
          await writeFile(target, "invalid-archive", { mode: 0o600 });
      }
      if (options.args.includes("pg_restore")) throw new Error("invalid dump");
      return { code: 0, stdout: "", stderr: "", durationMilliseconds: 1 };
    });
    const adapter = new PostgresBackupAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: resolve("distribution/self-hosted/compose.yaml"),
      projectName: "skillwire-test",
      installationId: randomUUID(),
      protectedRoot: fixture.root,
      backupsRoot: resolve(fixture.root, "backups"),
      postgresImage: `docker.io/library/postgres@sha256:${"c".repeat(64)}`,
      run,
      validateRestoredDatabase: vi.fn(),
    });
    await expect(
      adapter.createAndValidate(new AbortController().signal),
    ).rejects.toThrow(/archive|dump|restore/i);
    expect(
      commands.some(
        ({ args }) => args.includes("volume") && args.includes("rm"),
      ),
    ).toBe(true);
  });

  it("removes the incomplete backup set when pg_dump fails before copy", async () => {
    fixture = await createOnboardingEnvironment();
    const backupsRoot = resolve(fixture.root, "backups");
    const adapter = new PostgresBackupAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: resolve("distribution/self-hosted/compose.yaml"),
      projectName: "skillwire-test",
      installationId: randomUUID(),
      protectedRoot: fixture.root,
      backupsRoot,
      postgresImage: `docker.io/library/postgres@sha256:${"c".repeat(64)}`,
      run: async (options) => {
        const context = localDockerContext(options);
        if (context !== undefined) return context;
        if (options.args.includes("pg_dump")) throw new Error("dump failed");
        return { code: 0, stdout: "", stderr: "", durationMilliseconds: 1 };
      },
      validateRestoredDatabase: vi.fn(),
    });

    await expect(
      adapter.createAndValidate(new AbortController().signal),
    ).rejects.toThrow(/dump/i);
    expect(await readdir(backupsRoot)).toEqual([]);
  });

  it("restore-validates the exact pre-upgrade schema instead of assuming 010", async () => {
    fixture = await createOnboardingEnvironment();
    const run = vi.fn(async (options: CommandOptions) => {
      const context = localDockerContext(options);
      if (context !== undefined) return context;
      if (
        options.args.includes("compose") &&
        options.args.includes("cp") &&
        options.args.at(-1)?.endsWith(".dump")
      ) {
        const target = options.args.at(-1);
        if (target !== undefined)
          await writeFile(target, "PGDMP\0schema-009", { mode: 0o600 });
      }
      return { code: 0, stdout: "", stderr: "", durationMilliseconds: 1 };
    });
    const adapter = new PostgresBackupAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: resolve("distribution/self-hosted/compose.yaml"),
      projectName: "skillwire-test",
      installationId: randomUUID(),
      protectedRoot: fixture.root,
      backupsRoot: resolve(fixture.root, "backups"),
      postgresImage: `docker.io/library/postgres@sha256:${"d".repeat(64)}`,
      expectedLatestMigration: "009",
      run,
      validateRestoredDatabase: async () => completeValidation("009"),
    });

    await expect(
      adapter.createAndValidate(new AbortController().signal),
    ).resolves.toMatchObject({ validation: { latestMigration: "009" } });
  });

  it("uses an independent bounded signal to remove validation resources after cancellation", async () => {
    fixture = await createOnboardingEnvironment();
    const controller = new AbortController();
    const cleanupSignals: AbortSignal[] = [];
    const run = vi.fn(async (options: CommandOptions) => {
      const context = localDockerContext(options);
      if (context !== undefined) return context;
      if (
        options.args.includes("compose") &&
        options.args.includes("cp") &&
        options.args.at(-1)?.endsWith(".dump")
      ) {
        const target = options.args.at(-1);
        if (target !== undefined)
          await writeFile(target, "PGDMP\0cancelled", { mode: 0o600 });
      }
      if (options.args[0] === "run") controller.abort();
      if (
        (options.args.includes("container") && options.args.includes("rm")) ||
        (options.args.includes("volume") && options.args.includes("rm"))
      )
        cleanupSignals.push(options.signal ?? AbortSignal.abort());
      return { code: 0, stdout: "", stderr: "", durationMilliseconds: 1 };
    });
    const adapter = new PostgresBackupAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: resolve("distribution/self-hosted/compose.yaml"),
      projectName: "skillwire-test",
      installationId: randomUUID(),
      protectedRoot: fixture.root,
      backupsRoot: resolve(fixture.root, "backups"),
      postgresImage: `docker.io/library/postgres@sha256:${"e".repeat(64)}`,
      run,
      validateRestoredDatabase: vi.fn(),
    });

    await expect(adapter.createAndValidate(controller.signal)).rejects.toThrow(
      /cancel|validation/i,
    );
    expect(cleanupSignals).toHaveLength(2);
    expect(cleanupSignals.every((signal) => !signal.aborted)).toBe(true);
  });

  it("rejects a symlinked backup ancestor before creating anything outside the protected root", async () => {
    fixture = await createOnboardingEnvironment();
    const protectedRoot = resolve(fixture.root, "protected-data");
    const outside = resolve(fixture.root, "outside-data");
    await Promise.all([
      mkdir(protectedRoot, { mode: 0o700 }),
      mkdir(outside, { mode: 0o700 }),
    ]);
    await symlink(outside, resolve(protectedRoot, "redirect"));
    const escaped = resolve(outside, "generated-backups");
    const run = vi.fn();
    const adapter = new PostgresBackupAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: resolve("distribution/self-hosted/compose.yaml"),
      projectName: "skillwire-test",
      installationId: randomUUID(),
      protectedRoot,
      backupsRoot: resolve(protectedRoot, "redirect", "generated-backups"),
      postgresImage: `docker.io/library/postgres@sha256:${"f".repeat(64)}`,
      run,
      validateRestoredDatabase: vi.fn(),
    });

    await expect(
      adapter.createAndValidate(new AbortController().signal),
    ).rejects.toThrow(/symbolic link|owned root|unsafe/i);
    await expect(access(escaped)).rejects.toMatchObject({ code: "ENOENT" });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a named remote Docker context before the first backup workload command", async () => {
    fixture = await createOnboardingEnvironment();
    const commands: CommandOptions[] = [];
    const run = vi.fn(async (options: CommandOptions) => {
      commands.push(options);
      if (options.args[0] === "context" && options.args[1] === "show")
        return {
          code: 0,
          stdout: "remote-proof\n",
          stderr: "",
          durationMilliseconds: 1,
        };
      if (options.args[0] === "context" && options.args[1] === "inspect")
        return {
          code: 0,
          stdout: "ssh://builder@example.test\n",
          stderr: "",
          durationMilliseconds: 1,
        };
      return { code: 0, stdout: "", stderr: "", durationMilliseconds: 1 };
    });
    const adapter = new PostgresBackupAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: resolve("distribution/self-hosted/compose.yaml"),
      projectName: "skillwire-test",
      installationId: randomUUID(),
      protectedRoot: fixture.root,
      backupsRoot: resolve(fixture.root, "backups"),
      postgresImage: `docker.io/library/postgres@sha256:${"a".repeat(64)}`,
      environment: {
        DOCKER_CONTEXT: "remote-proof",
        DOCKER_CONFIG: resolve(fixture.root, "docker-config"),
      },
      run,
      validateRestoredDatabase: vi.fn(),
    });

    await expect(
      adapter.createAndValidate(new AbortController().signal),
    ).rejects.toThrow(/local Docker context|remote/i);
    expect(commands.some(({ args }) => args.includes("pg_dump"))).toBe(false);
    expect(commands.map(({ args }) => args).slice(0, 2)).toEqual([
      ["context", "show"],
      [
        "context",
        "inspect",
        "remote-proof",
        "--format",
        "{{.Endpoints.docker.Host}}",
      ],
    ]);
  });

  it("pins an accepted named context endpoint for every backup workload command", async () => {
    fixture = await createOnboardingEnvironment();
    const commands: CommandOptions[] = [];
    const endpoint = `unix://${fixture.runtimeRoot}/docker.sock`;
    const run = vi.fn(async (options: CommandOptions) => {
      commands.push(options);
      if (options.args[0] === "context")
        return {
          code: 0,
          stdout: options.args[1] === "show" ? "rootless\n" : `${endpoint}\n`,
          stderr: "",
          durationMilliseconds: 1,
        };
      if (
        options.args.includes("compose") &&
        options.args.includes("cp") &&
        options.args.at(-1)?.endsWith(".dump")
      ) {
        const target = options.args.at(-1);
        if (target !== undefined)
          await writeFile(target, "PGDMP\0pinned-context", { mode: 0o600 });
      }
      return { code: 0, stdout: "", stderr: "", durationMilliseconds: 1 };
    });
    const adapter = new PostgresBackupAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: resolve("distribution/self-hosted/compose.yaml"),
      projectName: "skillwire-test",
      installationId: randomUUID(),
      protectedRoot: fixture.root,
      backupsRoot: resolve(fixture.root, "backups"),
      postgresImage: `docker.io/library/postgres@sha256:${"a".repeat(64)}`,
      environment: { DOCKER_CONTEXT: "rootless" },
      run,
      validateRestoredDatabase: async () => completeValidation(),
    });

    await expect(
      adapter.createAndValidate(new AbortController().signal),
    ).resolves.toMatchObject({ validation: { ready: true } });
    const workload = commands.filter(({ args }) => args[0] !== "context");
    expect(workload.length).toBeGreaterThan(0);
    expect(
      workload.every(
        ({ environment }) =>
          environment?.["DOCKER_HOST"] === endpoint &&
          environment["DOCKER_CONTEXT"] === undefined,
      ),
    ).toBe(true);
  });

  const realPostgresIt =
    process.env["SKILLWIRE_RUN_POSTGRES_BACKUP_INTEGRATION"] === "1"
      ? it
      : it.skip;

  realPostgresIt(
    "creates and restore-validates a real PostgreSQL custom archive in disposable Docker resources",
    async () => {
      fixture = await createOnboardingEnvironment();
      const digest =
        "742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
      const image = `docker.io/library/postgres@sha256:${digest}`;
      const projectName = `skillwire-real-${randomUUID().slice(0, 12)}`;
      const composePath = resolve(fixture.root, "compose.yaml");
      const dockerEnvironment: NodeJS.ProcessEnv = {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        DOCKER_HOST: process.env["DOCKER_HOST"],
      };
      await writeFile(
        composePath,
        [
          "services:",
          "  postgres:",
          `    image: ${image}`,
          "    environment:",
          "      POSTGRES_HOST_AUTH_METHOD: trust",
          "      POSTGRES_USER: skillwire",
          "      POSTGRES_DB: skillwire",
          "    healthcheck:",
          "      test: [CMD-SHELL, pg_isready -U skillwire -d skillwire]",
          "      interval: 1s",
          "      timeout: 2s",
          "      retries: 30",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const composeArgs = [
        "compose",
        "--project-name",
        projectName,
        "--file",
        composePath,
      ];
      try {
        await runCommand({
          executable: "/usr/bin/docker",
          args: [...composeArgs, "up", "--detach", "--wait"],
          environment: dockerEnvironment,
          deadlineMilliseconds: 120_000,
        });
        await runCommand({
          executable: "/usr/bin/docker",
          args: [
            ...composeArgs,
            "exec",
            "-T",
            "postgres",
            "psql",
            "--username=skillwire",
            "--dbname=skillwire",
            "--set=ON_ERROR_STOP=1",
            "--file=-",
          ],
          environment: dockerEnvironment,
          stdin: [
            "CREATE TABLE schema_migrations (version text PRIMARY KEY);",
            "INSERT INTO schema_migrations(version) VALUES ('011');",
            "CREATE TABLE accounts (id uuid PRIMARY KEY);",
            "CREATE TABLE external_skill_revisions (id uuid PRIMARY KEY);",
            "CREATE TABLE external_advisory_chain_head (singleton boolean PRIMARY KEY);",
          ].join("\n"),
          deadlineMilliseconds: 30_000,
        });
        const adapter = new PostgresBackupAdapter({
          dockerExecutable: "/usr/bin/docker",
          composePath,
          projectName,
          installationId: randomUUID(),
          protectedRoot: fixture.root,
          backupsRoot: resolve(fixture.root, "backups"),
          postgresImage: image,
          environment: dockerEnvironment,
          validateRestoredDatabase: async (containerName, validationSignal) => {
            const inspected = await runCommand({
              executable: "/usr/bin/docker",
              args: [
                "exec",
                containerName,
                "psql",
                "--username=postgres",
                "--dbname=postgres",
                "--tuples-only",
                "--no-align",
                "--set=ON_ERROR_STOP=1",
                "--command",
                "SELECT concat((SELECT max(version) FROM schema_migrations),'|',(to_regclass('public.accounts') IS NOT NULL)::text,'|',(to_regclass('public.external_skill_revisions') IS NOT NULL)::text,'|',(to_regclass('public.external_advisory_chain_head') IS NOT NULL)::text)",
              ],
              environment: dockerEnvironment,
              signal: validationSignal,
              deadlineMilliseconds: 30_000,
            });
            const [migration, accounts, catalog, advisory] = inspected.stdout
              .trim()
              .split("|");
            return {
              ...completeValidation(migration ?? ""),
              constraintsValid: accounts === "true",
              catalogValid: catalog === "true" && advisory === "true",
              ready: migration === "011",
            };
          },
        });

        const backup = await adapter.createAndValidate(
          AbortSignal.timeout(120_000),
        );
        expect(backup.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(backup).toMatchObject({
          validation: {
            latestMigration: "011",
            migrationInventoryValid: true,
            constraintsValid: true,
            catalogValid: true,
            advisoryValid: true,
            authoritativeStateValid: true,
            ready: true,
          },
        });
      } finally {
        await runCommand({
          executable: "/usr/bin/docker",
          args: [...composeArgs, "down", "--volumes", "--remove-orphans"],
          environment: dockerEnvironment,
          acceptExitCodes: [0, 1],
          deadlineMilliseconds: 60_000,
        }).catch(() => undefined);
      }
    },
    180_000,
  );
});
