import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFakeExecutables } from "../../helpers/onboarding-executables.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import {
  CommandFailure,
  runCommand,
} from "../../../src/onboarding/adapters/process/command-runner.js";
import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";

describe("bounded command runner", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("requires absolute executables, shell false, sanitized env, and bounded output", async () => {
    fixture = await createOnboardingEnvironment();
    const binaries = await createFakeExecutables(fixture.root);
    await expect(runCommand({ executable: "codex", args: [] })).rejects.toThrow(
      /absolute/,
    );
    const result = await runCommand({
      executable: binaries.codex,
      args: ["mcp", "list"],
      environment: { ...fixture.environment, FORBIDDEN_PARENT: undefined },
      deadlineMilliseconds: 2_000,
      maximumOutputBytes: 4_096,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"name":"codex"');
    expect(result.stdout).not.toContain("FORBIDDEN_PARENT");
  });

  it("enforces deadlines, cancellation, and redacts bounded failures", async () => {
    fixture = await createOnboardingEnvironment();
    const binaries = await createFakeExecutables(fixture.root);
    await expect(
      runCommand({
        executable: binaries.signal,
        args: [],
        environment: { ...fixture.environment, SKILLWIRE_FAKE_SIGNAL: "wait" },
        deadlineMilliseconds: 25,
      }),
    ).rejects.toMatchObject({ kind: "deadline" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCommand({
        executable: resolve(binaries.signal),
        args: [],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CommandFailure);
  });

  it("uses shell-free argv, strips secret env, enforces output limits, and redacts failures", async () => {
    const literal = "literal; echo must-not-run";
    const argv = await runCommand({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", literal],
    });
    expect(argv.stdout).toBe(literal);

    const environment = await runCommand({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({safe:process.env.SAFE_VALUE,secret:process.env.SKILLWIRE_CLIENT_SECRET}))",
      ],
      environment: {
        SAFE_VALUE: "visible",
        SKILLWIRE_CLIENT_SECRET: "must-not-reach-child",
      },
    });
    expect(JSON.parse(environment.stdout)).toEqual({ safe: "visible" });

    const injectionEnvironment = await runCommand({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({node:process.env.NODE_OPTIONS,preload:process.env.LD_PRELOAD,bash:process.env.BASH_ENV}))",
      ],
      environment: {
        NODE_OPTIONS: "--trace-warnings",
        LD_PRELOAD: "/tmp/untrusted.so",
        BASH_ENV: "/tmp/untrusted-shell",
      },
    });
    expect(JSON.parse(injectionEnvironment.stdout)).toEqual({});

    await expect(
      runCommand({
        executable: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(4096))"],
        maximumOutputBytes: 64,
      }),
    ).rejects.toMatchObject({ kind: "output-limit" });

    const token = createApiKeyToken().token;
    await expect(
      runCommand({
        executable: process.execPath,
        args: [
          "-e",
          "process.stderr.write(process.argv[1]);process.exit(7)",
          token,
        ],
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CommandFailure);
      expect((error as Error).message).toContain("[REDACTED]");
      expect((error as Error).message).not.toContain(token);
      return true;
    });

    const controller = new AbortController();
    const pending = runCommand({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      signal: controller.signal,
      deadlineMilliseconds: 2_000,
    });
    setTimeout(() => {
      controller.abort();
    }, 10);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("force-terminates a subprocess that ignores the bounded SIGTERM grace period", async () => {
    const started = performance.now();
    await expect(
      runCommand({
        executable: process.execPath,
        args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        deadlineMilliseconds: 25,
      }),
    ).rejects.toMatchObject({ kind: "deadline" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
