import { createServer } from "node:net";
import { isAbsolute, resolve } from "node:path";

import {
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "../process/command-runner.js";

type CommandExecutor = (options: CommandOptions) => Promise<CommandResult>;

export interface DeploymentOptions {
  readonly dockerExecutable: string;
  readonly composePath: string;
  readonly projectName: string;
  readonly volumeName: string;
  readonly skillwireImage: string;
  readonly postgresImage: string;
  readonly databasePasswordFile: string;
  readonly applicationPepperFile: string;
  readonly port: number;
  readonly run?: CommandExecutor | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly ensurePortAvailable?: ((port: number) => Promise<void>) | undefined;
}

async function defaultPortProbe(port: number): Promise<void> {
  await new Promise<void>((done, reject) => {
    const server = createServer();
    server.once("error", () => {
      reject(new Error(`Loopback port ${String(port)} is occupied`));
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => {
        if (error === undefined) done();
        else reject(error);
      });
    });
  });
}

function expectedDigest(reference: string): string {
  if (
    !/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?\/)[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/.test(
      reference,
    )
  ) {
    throw new Error(
      "Deployment image is not a canonical digest-pinned reference",
    );
  }
  return reference;
}

function canonicalDockerReference(reference: string): string {
  const at = reference.lastIndexOf("@");
  if (at < 1) return reference;
  const repository = reference.slice(0, at);
  const digest = reference.slice(at);
  const first = repository.split("/")[0] ?? "";
  if (!repository.includes("/"))
    return `docker.io/library/${repository}${digest}`;
  if (!first.includes(".") && !first.includes(":") && first !== "localhost") {
    return `docker.io/${repository}${digest}`;
  }
  return reference;
}

export class DeploymentAdapter {
  private readonly run: CommandExecutor;
  private readonly fetch: typeof fetch;

  public constructor(private readonly options: DeploymentOptions) {
    if (
      !isAbsolute(options.dockerExecutable) ||
      !isAbsolute(options.composePath)
    )
      throw new Error("Docker and Compose paths must be absolute");
    if (
      !/^skillwire-[a-z0-9-]+$/.test(options.projectName) ||
      options.volumeName !== `${options.projectName}_postgres_data`
    ) {
      throw new Error("Deployment resource names are not installation-bound");
    }
    if (
      !Number.isInteger(options.port) ||
      options.port < 1024 ||
      options.port > 65535
    )
      throw new Error("Loopback service port is invalid");
    expectedDigest(options.skillwireImage);
    expectedDigest(options.postgresImage);
    this.run = options.run ?? runCommand;
    this.fetch = options.fetch ?? fetch;
  }

  private command(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return this.run({
      executable: resolve(this.options.dockerExecutable),
      args,
      environment: {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        SKILLWIRE_COMPOSE_PROJECT: this.options.projectName,
        SKILLWIRE_POSTGRES_VOLUME: this.options.volumeName,
        SKILLWIRE_IMAGE: this.options.skillwireImage,
        SKILLWIRE_POSTGRES_IMAGE: this.options.postgresImage,
        SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE:
          this.options.databasePasswordFile,
        SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE:
          this.options.applicationPepperFile,
        SKILLWIRE_PORT: String(this.options.port),
      },
      deadlineMilliseconds: 60_000,
      maximumOutputBytes: 256 * 1024,
      signal,
    });
  }

  async probe(): Promise<void> {
    const docker = await this.command(["--version"]);
    const dockerVersion = /Docker version\s+(\d+)\.(\d+)\.(\d+)/.exec(
      docker.stdout,
    );
    if (dockerVersion === null || Number(dockerVersion[1]) < 27)
      throw new Error("Unsupported Docker version");
    const compose = await this.command(["compose", "version"]);
    const composeVersion = /version\s+v?(\d+)\.(\d+)\.(\d+)/i.exec(
      compose.stdout,
    );
    if (composeVersion === null || Number(composeVersion[1]) < 2)
      throw new Error("Unsupported Docker Compose version");
    const context = (await this.command(["context", "show"])).stdout.trim();
    const endpoint = (
      await this.command([
        "context",
        "inspect",
        context,
        "--format",
        "{{.Endpoints.docker.Host}}",
      ])
    ).stdout.trim();
    if (!endpoint.startsWith("unix://") && !endpoint.startsWith("npipe://"))
      throw new Error(
        "A local Docker context is required; remote contexts are refused",
      );
    for (const image of [
      this.options.skillwireImage,
      this.options.postgresImage,
    ]) {
      const inspected = (
        await this.command([
          "image",
          "inspect",
          "--format",
          "{{json .RepoDigests}}",
          image,
        ])
      ).stdout.trim();
      let repoDigests: unknown;
      try {
        repoDigests = JSON.parse(inspected) as unknown;
      } catch {
        throw new Error("Docker returned an invalid image identity inventory");
      }
      if (
        !Array.isArray(repoDigests) ||
        !repoDigests.some(
          (candidate) =>
            typeof candidate === "string" &&
            canonicalDockerReference(candidate) ===
              canonicalDockerReference(image),
        )
      ) {
        throw new Error(
          "Locally available image identity does not match the release digest",
        );
      }
    }
  }

  async deploy(signal: AbortSignal): Promise<void> {
    await (this.options.ensurePortAvailable ?? defaultPortProbe)(
      this.options.port,
    );
    const composeBase = [
      "compose",
      "--project-name",
      this.options.projectName,
      "--file",
      this.options.composePath,
    ];
    await this.command([...composeBase, "config", "--quiet"], signal);
    await this.command(
      [
        ...composeBase,
        "up",
        "--detach",
        "--no-build",
        "--wait",
        "--wait-timeout",
        "60",
      ],
      signal,
    );
    const deadline = performance.now() + 30_000;
    let lastError: unknown;
    while (performance.now() < deadline && !signal.aborted) {
      try {
        const response = await this.fetch(
          `http://127.0.0.1:${String(this.options.port)}/health/ready`,
          {
            redirect: "error",
            signal: AbortSignal.timeout(2_000),
          },
        );
        if (response.ok) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    if (signal.aborted)
      throw new Error("Deployment cancelled at a safe boundary");
    throw new Error(
      `SkillWire readiness failed${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
    );
  }
}
