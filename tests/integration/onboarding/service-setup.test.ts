import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DeploymentAdapter } from "../../../src/onboarding/adapters/docker/deployment.js";
import type {
  CommandOptions,
  CommandResult,
} from "../../../src/onboarding/adapters/process/command-runner.js";
import { CommandFailure } from "../../../src/onboarding/adapters/process/command-runner.js";

let runtimeDirectory: string;

describe("service-only deployment boundary", () => {
  beforeAll(async () => {
    runtimeDirectory = await mkdtemp(resolve(tmpdir(), "skillwire-socket-"));
  });
  afterAll(async () => {
    await rm(runtimeDirectory, { recursive: true, force: true });
  });
  it("pulls each exact digest only when it is absent from a clean local cache", async () => {
    const cached = new Set<string>();
    const calls: string[][] = [];
    const run = vi.fn(
      async (options: CommandOptions): Promise<CommandResult> => {
        await Promise.resolve();
        calls.push([...options.args]);
        const joined = options.args.join(" ");
        const image = options.args.at(-1) ?? "";
        if (joined === "--version") return result("Docker version 29.7.2\n");
        if (joined === "compose version")
          return result("Docker Compose version v5.4.0\n");
        if (joined === "context show") return result("default\n");
        if (joined.includes("context inspect"))
          return result("unix:///var/run/docker.sock\n");
        if (options.args[0] === "pull") {
          cached.add(image);
          return result("");
        }
        if (joined.includes("image inspect")) {
          if (!cached.has(image))
            throw new CommandFailure("exit", "No such image", 1);
          return result(`${JSON.stringify([image])}\n`);
        }
        return result("");
      },
    );
    const adapter = deployment(run);

    await expect(adapter.probe()).resolves.toBeUndefined();
    expect(calls.filter(([command]) => command === "pull")).toEqual([
      ["pull", `localhost:5000/skillwire@sha256:${"1".repeat(64)}`],
      ["pull", `docker.io/library/postgres@sha256:${"2".repeat(64)}`],
    ]);
  });

  it("enforces supported versions, local context, digest images, migration gate, loopback readiness, and stable names", async () => {
    const calls: CommandOptions[] = [];
    const run = vi.fn((options: CommandOptions): Promise<CommandResult> => {
      calls.push(options);
      const joined = options.args.join(" ");
      const stdout =
        joined === "--version"
          ? "Docker version 29.7.2, build fixture\n"
          : joined === "compose version"
            ? "Docker Compose version v5.4.0\n"
            : joined === "context show"
              ? "default\n"
              : joined.includes("context inspect")
                ? "unix:///var/run/docker.sock\n"
                : joined.includes("image inspect")
                  ? `${JSON.stringify([options.args.at(-1) ?? ""])}\n`
                  : "";
      return Promise.resolve({
        code: 0,
        stdout,
        stderr: "",
        durationMilliseconds: 1,
      });
    });
    const adapter = new DeploymentAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: resolve("distribution/self-hosted/compose.yaml"),
      projectName: "skillwire-test-0123456789abcdef",
      volumeName: "skillwire-test-0123456789abcdef_postgres_data",
      skillwireImage: `localhost:5000/skillwire@sha256:${"1".repeat(64)}`,
      postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
      databasePasswordFile: "/tmp/disposable/database-password",
      applicationPepperFile: "/tmp/disposable/application-pepper",
      runtimeSocketDirectory: runtimeDirectory,
      socketPath: resolve(runtimeDirectory, "mcp.sock"),
      run,
      readinessProbe: () => Promise.resolve(true),
    });
    await adapter.probe();
    await adapter.deploy(new AbortController().signal);
    expect(
      calls.some(({ args }) => args.join(" ").includes("context inspect")),
    ).toBe(true);
    expect(
      calls.some(
        ({ args }) => args.includes("config") && args.includes("--quiet"),
      ),
    ).toBe(true);
    expect(
      calls.some(({ args }) => args.includes("up") && args.includes("--wait")),
    ).toBe(true);
    expect(
      calls.some(
        ({ args }) => args.includes("up") && args.includes("--no-build"),
      ),
    ).toBe(true);
    expect(
      calls.every(
        ({ environment }) =>
          environment?.["SKILLWIRE_RUNTIME_UID"] !== undefined &&
          environment["SKILLWIRE_RUNTIME_GID"] !== undefined &&
          environment["SKILLWIRE_RUNTIME_SOCKET_DIRECTORY"] ===
            runtimeDirectory,
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ args }) => args.includes("build") || args.includes("--build"),
      ),
    ).toBe(false);
    expect(calls.some(({ args }) => args[0] === "pull")).toBe(false);
    expect(JSON.stringify(calls)).not.toMatch(/temporary-fixture-value/i);
  });

  it("fails closed when an exact digest cannot be pulled", async () => {
    const run = vi.fn(async (options: CommandOptions) => {
      await Promise.resolve();
      const joined = options.args.join(" ");
      if (joined === "--version") return result("Docker version 29.7.2\n");
      if (joined === "compose version")
        return result("Docker Compose version v5.4.0\n");
      if (joined === "context show") return result("default\n");
      if (joined.includes("context inspect"))
        return result("unix:///var/run/docker.sock\n");
      if (options.args[0] === "pull")
        throw new CommandFailure("exit", "registry unavailable", 1);
      throw new CommandFailure("exit", "No such image", 1);
    });

    await expect(deployment(run).probe()).rejects.toThrow(
      /registry unavailable/,
    );
  });

  it("rejects digest substitution after a clean-cache pull", async () => {
    let inspected = false;
    const run = vi.fn(async (options: CommandOptions) => {
      await Promise.resolve();
      const joined = options.args.join(" ");
      if (joined === "--version") return result("Docker version 29.7.2\n");
      if (joined === "compose version")
        return result("Docker Compose version v5.4.0\n");
      if (joined === "context show") return result("default\n");
      if (joined.includes("context inspect"))
        return result("unix:///var/run/docker.sock\n");
      if (options.args[0] === "pull") {
        inspected = true;
        return result("");
      }
      if (joined.includes("image inspect") && !inspected)
        throw new CommandFailure("exit", "No such image", 1);
      if (joined.includes("image inspect"))
        return result(
          `${JSON.stringify([
            `localhost:5000/skillwire@sha256:${"f".repeat(64)}`,
          ])}\n`,
        );
      return result("");
    });

    await expect(deployment(run).probe()).rejects.toThrow(/does not match/i);
  });

  it("rejects mutable image tags before any Docker command", () => {
    expect(
      () =>
        new DeploymentAdapter({
          dockerExecutable: "/usr/bin/docker",
          composePath: "/tmp/disposable/compose.yaml",
          projectName: "skillwire-test-0123456789abcdef",
          volumeName: "skillwire-test-0123456789abcdef_postgres_data",
          skillwireImage: "localhost:5000/skillwire:latest",
          postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
          databasePasswordFile: "/tmp/disposable/database-password",
          applicationPepperFile: "/tmp/disposable/application-pepper",
          runtimeSocketDirectory: runtimeDirectory,
          socketPath: resolve(runtimeDirectory, "mcp.sock"),
          run: vi.fn(),
        }),
    ).toThrow(/digest-pinned/i);
  });

  it("rejects remote Docker contexts before Compose mutation", async () => {
    const run = vi.fn((options: CommandOptions): Promise<CommandResult> =>
      Promise.resolve({
        code: 0,
        stdout: options.args.join(" ").includes("context inspect")
          ? "tcp://remote.example:2376\n"
          : options.args.join(" ") === "--version"
            ? "Docker version 29.7.2\n"
            : options.args.join(" ") === "compose version"
              ? "Docker Compose version v5.4.0\n"
              : "default\n",
        stderr: "",
        durationMilliseconds: 1,
      }),
    );
    const adapter = new DeploymentAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: "/tmp/disposable/compose.yaml",
      projectName: "skillwire-test-0123456789abcdef",
      volumeName: "skillwire-test-0123456789abcdef_postgres_data",
      skillwireImage: `localhost:5000/skillwire@sha256:${"1".repeat(64)}`,
      postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
      databasePasswordFile: "/tmp/disposable/database-password",
      applicationPepperFile: "/tmp/disposable/application-pepper",
      runtimeSocketDirectory: runtimeDirectory,
      socketPath: resolve(runtimeDirectory, "mcp.sock"),
      run,
    });
    await expect(adapter.probe()).rejects.toThrow(/local|remote/i);
    expect(
      run.mock.calls.some(([options]) => {
        const args = options.args;
        return args.includes("config") || args.includes("up");
      }),
    ).toBe(false);
  });

  it("rejects a pre-existing exact Compose project or volume before deployment", async () => {
    const calls: CommandOptions[] = [];
    const run = vi.fn((options: CommandOptions) => {
      calls.push(options);
      const joined = options.args.join(" ");
      if (joined.startsWith("container ls"))
        return Promise.resolve(result("existing-container\n"));
      if (joined.startsWith("volume ls"))
        return Promise.resolve(
          result("skillwire-test-0123456789abcdef_postgres_data\n"),
        );
      return Promise.resolve(result(""));
    });
    const adapter = deployment(run);

    await expect(
      adapter.assertDeploymentTargetsAbsent(new AbortController().signal),
    ).rejects.toThrow(/already exists|collision/i);
    expect(
      calls.some(({ args }) => args.includes("up") || args.includes("down")),
    ).toBe(false);
  });

  it("uses an already resolved local endpoint without re-reading another context", async () => {
    const run = vi.fn(async (options: CommandOptions) => {
      await Promise.resolve();
      const joined = options.args.join(" ");
      if (joined.startsWith("context "))
        throw new Error("the default context must not replace a pinned host");
      if (joined === "--version") return result("Docker version 29.7.2\n");
      if (joined === "compose version")
        return result("Docker Compose version v5.4.0\n");
      if (joined.includes("image inspect"))
        return result(`${JSON.stringify([options.args.at(-1) ?? ""])}\n`);
      return result("");
    });
    const adapter = new DeploymentAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: "/tmp/disposable/compose.yaml",
      projectName: "skillwire-test-0123456789abcdef",
      volumeName: "skillwire-test-0123456789abcdef_postgres_data",
      skillwireImage: `localhost:5000/skillwire@sha256:${"1".repeat(64)}`,
      postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
      databasePasswordFile: "/tmp/disposable/database-password",
      applicationPepperFile: "/tmp/disposable/application-pepper",
      runtimeSocketDirectory: runtimeDirectory,
      socketPath: resolve(runtimeDirectory, "mcp.sock"),
      hostEnvironment: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
      run,
    });

    await expect(adapter.probe()).resolves.toBeUndefined();
    expect(
      run.mock.calls.every(
        ([options]) =>
          options.environment?.["DOCKER_HOST"] ===
          "unix:///run/user/1000/docker.sock",
      ),
    ).toBe(true);
  });

  it("rejects an unsafe socket directory before Compose mutation", async () => {
    const run = vi.fn<(options: CommandOptions) => Promise<CommandResult>>();
    const unsafeDirectory = resolve(runtimeDirectory, "unsafe");
    await mkdir(unsafeDirectory, { mode: 0o755 });
    const adapter = new DeploymentAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: "/tmp/disposable/compose.yaml",
      projectName: "skillwire-test-0123456789abcdef",
      volumeName: "skillwire-test-0123456789abcdef_postgres_data",
      skillwireImage: `localhost:5000/skillwire@sha256:${"1".repeat(64)}`,
      postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
      databasePasswordFile: "/tmp/disposable/database-password",
      applicationPepperFile: "/tmp/disposable/application-pepper",
      runtimeSocketDirectory: unsafeDirectory,
      socketPath: resolve(unsafeDirectory, "mcp.sock"),
      run,
    });
    await expect(adapter.deploy(new AbortController().signal)).rejects.toThrow(
      /unsafe/i,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("observes one owned Compose service without inserting a second compose subcommand", async () => {
    const calls: CommandOptions[] = [];
    const run = vi.fn((options: CommandOptions) => {
      calls.push(options);
      return Promise.resolve(
        options.args.includes("ps")
          ? result("container-id\n")
          : result(
              `skillwire-test-0123456789abcdef|skillwire|localhost:5000/skillwire@sha256:${"1".repeat(64)}\n`,
            ),
      );
    });

    await expect(
      deployment(run).observeOwnedService(
        "skillwire",
        new AbortController().signal,
      ),
    ).resolves.toBe(true);
    expect(calls[0]?.args).toEqual([
      "compose",
      "--project-name",
      "skillwire-test-0123456789abcdef",
      "--file",
      "/tmp/disposable/compose.yaml",
      "ps",
      "--all",
      "--quiet",
      "skillwire",
    ]);
    expect(calls[0]?.args.filter((arg) => arg === "compose")).toHaveLength(1);
  });
});

function result(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: "", durationMilliseconds: 1 };
}

function deployment(run: (options: CommandOptions) => Promise<CommandResult>) {
  return new DeploymentAdapter({
    dockerExecutable: "/usr/bin/docker",
    composePath: "/tmp/disposable/compose.yaml",
    projectName: "skillwire-test-0123456789abcdef",
    volumeName: "skillwire-test-0123456789abcdef_postgres_data",
    skillwireImage: `localhost:5000/skillwire@sha256:${"1".repeat(64)}`,
    postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
    databasePasswordFile: "/tmp/disposable/database-password",
    applicationPepperFile: "/tmp/disposable/application-pepper",
    runtimeSocketDirectory: runtimeDirectory,
    socketPath: resolve(runtimeDirectory, "mcp.sock"),
    run,
  });
}
