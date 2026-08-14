import { request as httpRequest } from "node:http";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  CommandFailure,
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "../process/command-runner.js";
import { dockerProcessEnvironment } from "./environment.js";

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
  readonly runtimeSocketDirectory: string;
  readonly socketPath: string;
  readonly hostEnvironment?: NodeJS.ProcessEnv | undefined;
  readonly run?: CommandExecutor | undefined;
  readonly readinessProbe?:
    ((socketPath: string, signal: AbortSignal) => Promise<boolean>) | undefined;
}

async function defaultReadinessProbe(
  socketPath: string,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((done, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: "/health/ready",
        method: "GET",
        headers: { host: "localhost" },
        signal,
      },
      (response) => {
        response.resume();
        done(response.statusCode === 200);
      },
    );
    request.once("error", reject);
    request.end();
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
  private readonly readinessProbe: (
    socketPath: string,
    signal: AbortSignal,
  ) => Promise<boolean>;

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
      !isAbsolute(options.runtimeSocketDirectory) ||
      !isAbsolute(options.socketPath) ||
      resolve(options.socketPath) !==
        resolve(options.runtimeSocketDirectory, "mcp.sock") ||
      options.socketPath.length > 103
    )
      throw new Error("Runtime Unix socket identity is invalid");
    expectedDigest(options.skillwireImage);
    expectedDigest(options.postgresImage);
    this.run = options.run ?? runCommand;
    this.readinessProbe = options.readinessProbe ?? defaultReadinessProbe;
  }

  private command(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return this.run({
      executable: resolve(this.options.dockerExecutable),
      args,
      environment: {
        ...dockerProcessEnvironment(this.options.hostEnvironment ?? {}),
        SKILLWIRE_COMPOSE_PROJECT: this.options.projectName,
        SKILLWIRE_POSTGRES_VOLUME: this.options.volumeName,
        SKILLWIRE_IMAGE: this.options.skillwireImage,
        SKILLWIRE_POSTGRES_IMAGE: this.options.postgresImage,
        SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE:
          this.options.databasePasswordFile,
        SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE:
          this.options.applicationPepperFile,
        SKILLWIRE_RUNTIME_SOCKET_DIRECTORY: this.options.runtimeSocketDirectory,
        SKILLWIRE_RUNTIME_UID: String(process.getuid?.() ?? 10001),
        SKILLWIRE_RUNTIME_GID: String(process.getgid?.() ?? 10001),
      },
      deadlineMilliseconds: 60_000,
      maximumOutputBytes: 256 * 1024,
      signal,
    });
  }

  async probe(signal?: AbortSignal): Promise<void> {
    const docker = await this.command(["--version"], signal);
    const dockerVersion = /Docker version\s+(\d+)\.(\d+)\.(\d+)/.exec(
      docker.stdout,
    );
    if (dockerVersion === null || Number(dockerVersion[1]) < 27)
      throw new Error("Unsupported Docker version");
    const compose = await this.command(["compose", "version"], signal);
    const composeVersion = /version\s+v?(\d+)\.(\d+)\.(\d+)/i.exec(
      compose.stdout,
    );
    if (composeVersion === null || Number(composeVersion[1]) < 2)
      throw new Error("Unsupported Docker Compose version");
    const context = (
      await this.command(["context", "show"], signal)
    ).stdout.trim();
    const endpoint = (
      await this.command(
        [
          "context",
          "inspect",
          context,
          "--format",
          "{{.Endpoints.docker.Host}}",
        ],
        signal,
      )
    ).stdout.trim();
    if (!endpoint.startsWith("unix://") && !endpoint.startsWith("npipe://"))
      throw new Error(
        "A local Docker context is required; remote contexts are refused",
      );
    for (const image of [
      this.options.skillwireImage,
      this.options.postgresImage,
    ]) {
      let inspected: string;
      try {
        inspected = await this.inspectImage(image, signal);
      } catch (error) {
        if (!(error instanceof CommandFailure) || error.kind !== "exit")
          throw error;
        await this.command(["pull", image], signal);
        inspected = await this.inspectImage(image, signal);
      }
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

  private async inspectImage(
    image: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return (
      await this.command(
        ["image", "inspect", "--format", "{{json .RepoDigests}}", image],
        signal,
      )
    ).stdout.trim();
  }

  async deploy(signal: AbortSignal): Promise<void> {
    const runtime = await lstat(this.options.runtimeSocketDirectory);
    if (
      !runtime.isDirectory() ||
      runtime.isSymbolicLink() ||
      runtime.uid !== process.getuid?.() ||
      (runtime.mode & 0o777) !== 0o700
    ) {
      throw new Error("Runtime Unix socket directory is unsafe");
    }
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
        if (
          await this.readinessProbe(
            this.options.socketPath,
            AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
          )
        )
          return;
      } catch (error) {
        lastError = error;
      }
      await new Promise<void>((done, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(new Error("Deployment cancelled at a safe boundary"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          done();
        }, 100);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }
    if (signal.aborted)
      throw new Error("Deployment cancelled at a safe boundary");
    throw new Error(
      `SkillWire readiness failed${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
    );
  }

  async observeOwnedService(
    service: "skillwire" | "postgres",
    signal: AbortSignal,
  ): Promise<boolean> {
    const listed = await this.command(
      [
        "compose",
        "--project-name",
        this.options.projectName,
        "--file",
        this.options.composePath,
        "ps",
        "--all",
        "--quiet",
        service,
      ],
      signal,
    );
    const identities = listed.stdout.trim().split("\n").filter(Boolean);
    if (identities.length === 0) return false;
    if (identities.length !== 1)
      throw new Error("Owned Compose service identity is ambiguous");
    const inspected = await this.command(
      [
        "container",
        "inspect",
        identities[0] ?? "",
        "--format",
        '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Config.Image}}',
      ],
      signal,
    );
    const expectedImage =
      service === "skillwire"
        ? this.options.skillwireImage
        : this.options.postgresImage;
    if (
      inspected.stdout.trim() !==
      `${this.options.projectName}|${service}|${expectedImage}`
    )
      throw new Error("Owned Compose service labels or image identity drifted");
    return true;
  }
}
