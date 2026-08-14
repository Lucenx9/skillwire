import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildSelfHostedApplication } from "../../../scripts/build-self-hosted-app.js";
import { runCommand } from "../../../src/onboarding/adapters/process/command-runner.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

describe("distributed standalone skillwire executable", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("bundles the sole dispatcher without production client wrappers or external node_modules", async () => {
    fixture = await createOnboardingEnvironment();
    const output = resolve(fixture.root, "payload/app/skillwire.mjs");
    await mkdir(resolve(fixture.root, "payload/app"), {
      recursive: true,
      mode: 0o700,
    });
    await buildSelfHostedApplication({
      esbuildExecutable: resolve("node_modules/esbuild/bin/esbuild"),
      entrypoint: resolve("src/onboarding/cli/main.ts"),
      output,
    });
    const result = await runCommand({
      executable: process.execPath,
      args: [output, "status", "--output", "json"],
      cwd: fixture.repository,
      environment: fixture.environment,
      acceptExitCodes: [3],
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "status",
      exitClass: "unsupported-prerequisite",
    });
    expect(result.stderr).toBe("");
  });
});
