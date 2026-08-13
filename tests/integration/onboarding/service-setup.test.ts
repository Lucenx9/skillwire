import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DeploymentAdapter } from "../../../src/onboarding/adapters/docker/deployment.js";
import type {
  CommandOptions,
  CommandResult,
} from "../../../src/onboarding/adapters/process/command-runner.js";

describe("service-only deployment boundary", () => {
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
      port: 54321,
      run,
      fetch: () =>
        Promise.resolve(new Response('{"status":"ready"}', { status: 200 })),
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
          environment?.["SKILLWIRE_RUNTIME_UID"] === undefined,
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ args }) => args.includes("build") || args.includes("--build"),
      ),
    ).toBe(false);
    expect(JSON.stringify(calls)).not.toMatch(/temporary-fixture-value/i);
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
      port: 54321,
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

  it("rejects an occupied loopback port before Compose mutation", async () => {
    const run = vi.fn<(options: CommandOptions) => Promise<CommandResult>>();
    const adapter = new DeploymentAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: "/tmp/disposable/compose.yaml",
      projectName: "skillwire-test-0123456789abcdef",
      volumeName: "skillwire-test-0123456789abcdef_postgres_data",
      skillwireImage: `localhost:5000/skillwire@sha256:${"1".repeat(64)}`,
      postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
      databasePasswordFile: "/tmp/disposable/database-password",
      applicationPepperFile: "/tmp/disposable/application-pepper",
      port: 54321,
      run,
      ensurePortAvailable: () =>
        Promise.reject(new Error("Loopback port 54321 is occupied")),
    });
    await expect(adapter.deploy(new AbortController().signal)).rejects.toThrow(
      /occupied/i,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
