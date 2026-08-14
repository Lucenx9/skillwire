import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateTokenChannel } from "../../../src/onboarding/adapters/postgres/private-token-channel.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { runCommand } from "../../../src/onboarding/adapters/process/command-runner.js";

describe("private token FIFO ownership", () => {
  let fixture: OnboardingEnvironment | undefined;

  afterEach(async () => fixture?.close());

  it("owns the FIFO descriptor before delivery and receives one bounded token", async () => {
    fixture = await createOnboardingEnvironment();
    const fifo = resolve(fixture.runtimeRoot, "token");
    await runCommand({
      executable: "/usr/bin/mkfifo",
      args: ["--mode=0600", fifo],
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      deadlineMilliseconds: 2_000,
    });
    const channel = await PrivateTokenChannel.open(fifo);
    try {
      const token = `swk.${"A".repeat(16)}.${"B".repeat(43)}`;
      await writeFile(fifo, token, "ascii");
      await expect(channel.receive()).resolves.toBe(token);
    } finally {
      await channel.close();
    }
  });

  it("fails promptly when the producer completed without writing", async () => {
    fixture = await createOnboardingEnvironment();
    const fifo = resolve(fixture.runtimeRoot, "token");
    await runCommand({
      executable: "/usr/bin/mkfifo",
      args: ["--mode=0600", fifo],
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      deadlineMilliseconds: 2_000,
    });
    const channel = await PrivateTokenChannel.open(fifo);
    try {
      await expect(channel.receive()).rejects.toThrow(/did not deliver/i);
    } finally {
      await channel.close();
    }
  });

  it("refuses a regular-file substitution", async () => {
    fixture = await createOnboardingEnvironment();
    const path = resolve(fixture.runtimeRoot, "token");
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    await expect(PrivateTokenChannel.open(path)).rejects.toThrow(/fifo/i);
  });
});
