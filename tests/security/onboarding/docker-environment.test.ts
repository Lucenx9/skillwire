/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror the production command runner. */
import { describe, expect, it, vi } from "vitest";

import {
  assertLocalDockerContext,
  dockerProcessEnvironment,
} from "../../../src/onboarding/adapters/docker/environment.js";
import type { CommandOptions } from "../../../src/onboarding/adapters/process/command-runner.js";

describe("Docker subprocess environment isolation", () => {
  it("keeps only runtime routing and explicit non-secret Compose values", () => {
    const environment = dockerProcessEnvironment(
      {
        HOME: "/tmp/disposable-home",
        XDG_RUNTIME_DIR: "/tmp/disposable-runtime",
        DOCKER_HOST: "unix:///tmp/disposable-runtime/docker.sock",
        DOCKER_CONTEXT: "rootless",
        LANG: "it_IT.UTF-8",
        GH_TOKEN: "ambient-github-canary",
        OPENAI_API_KEY: "ambient-openai-canary",
        DATABASE_URL: "postgres://ambient-secret",
      },
      {
        SKILLWIRE_COMPOSE_PROJECT: "skillwire-test",
        SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE:
          "/tmp/disposable/secrets/database-password",
      },
    );

    expect(environment).toMatchObject({
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: "/tmp/disposable-home",
      XDG_RUNTIME_DIR: "/tmp/disposable-runtime",
      DOCKER_HOST: "unix:///tmp/disposable-runtime/docker.sock",
      DOCKER_CONTEXT: "rootless",
      SKILLWIRE_COMPOSE_PROJECT: "skillwire-test",
      SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE:
        "/tmp/disposable/secrets/database-password",
    });
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("DATABASE_URL");
  });

  it.each(["tcp://docker.example.test:2376", "ssh://builder@example.test"])(
    "rejects a named Docker context resolving to %s before any workload command",
    async (endpoint) => {
      const commands: CommandOptions[] = [];
      const run = vi.fn(async (options: CommandOptions) => {
        commands.push(options);
        return {
          code: 0,
          stdout:
            options.args[1] === "show" ? "remote-proof\n" : `${endpoint}\n`,
          stderr: "",
          durationMilliseconds: 1,
        };
      });

      await expect(
        assertLocalDockerContext({
          dockerExecutable: "/usr/bin/docker",
          environment: {
            DOCKER_CONTEXT: "remote-proof",
            DOCKER_CONFIG: "/tmp/disposable-docker-config",
          },
          signal: new AbortController().signal,
          run,
        }),
      ).rejects.toThrow(/local Docker context|remote/i);
      expect(commands.map(({ args }) => args)).toEqual([
        ["context", "show"],
        [
          "context",
          "inspect",
          "remote-proof",
          "--format",
          "{{.Endpoints.docker.Host}}",
        ],
      ]);
    },
  );

  it.each([
    "unix:///run/user/1000/docker.sock",
    "npipe:////./pipe/docker_engine",
  ])(
    "preserves a named Docker context resolving to local endpoint %s",
    async (endpoint) => {
      const run = vi.fn(async (options: CommandOptions) => ({
        code: 0,
        stdout: options.args[1] === "show" ? "rootless\n" : `${endpoint}\n`,
        stderr: "",
        durationMilliseconds: 1,
      }));

      await expect(
        assertLocalDockerContext({
          dockerExecutable: "/usr/bin/docker",
          environment: { DOCKER_CONTEXT: "rootless" },
          signal: new AbortController().signal,
          run,
        }),
      ).resolves.toBe(endpoint);
    },
  );

  it("accepts an explicit local Docker host without resolving an unrelated context", async () => {
    const run = vi.fn();
    await expect(
      assertLocalDockerContext({
        dockerExecutable: "/usr/bin/docker",
        environment: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
        signal: new AbortController().signal,
        run,
      }),
    ).resolves.toBe("unix:///run/user/1000/docker.sock");
    expect(run).not.toHaveBeenCalled();
  });
});
