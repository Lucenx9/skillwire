import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { ClaudeClientAdapter } from "../../../src/onboarding/adapters/clients/claude.js";

describe("Claude Code 2.1.229 clean normal-profile onboarding", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("uses explicit user scope for MCP add/readback/remove without alternate config homes", async () => {
    fixture = await createOnboardingEnvironment();
    const launcher = resolve(fixture.root, "owned/bin/skillwire");
    await mkdir(resolve(fixture.root, "owned/bin"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const adapter = new ClaudeClientAdapter(
      "/usr/bin/claude",
      fixture.environment,
    );
    const before = await adapter.preflight();
    expect(before.version).toBe("2.1.229");
    expect(before.mcp).toBe("absent");
    await adapter.addMcp(launcher, "00000000-0000-4000-8000-000000000001");
    const registration = await adapter.readMcp();
    expect(registration).toMatchObject({
      scope: "user",
      command: launcher,
      args: [
        "bridge",
        "--installation",
        "00000000-0000-4000-8000-000000000001",
        "--client",
        "claude",
      ],
    });
    await adapter.removeMcp();
    expect((await adapter.preflight()).mcp).toBe("absent");
    expect(fixture.environment["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  }, 30_000);

  it("installs, enables, reads, disables, and removes the release-local user plugin", async () => {
    fixture = await createOnboardingEnvironment();
    const adapter = new ClaudeClientAdapter(
      "/usr/bin/claude",
      fixture.environment,
    );
    const launcher = resolve(fixture.root, "owned/bin/skillwire");
    await mkdir(resolve(fixture.root, "owned/bin"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await adapter.addMcp(launcher, "00000000-0000-4000-8000-000000000001");
    const marketplace = resolve("distribution/claude-marketplace");
    await adapter.addPlugin(marketplace);
    expect(await adapter.readPlugin(marketplace)).toMatchObject({
      pluginId: "skillwire-autonomous-activation@skillwire",
      marketplaceName: "skillwire",
      version: "0.1.0",
      enabled: true,
    });
    expect((await adapter.readMcp()).command).toBe(launcher);
    await adapter.removePlugin();
    await adapter.removeMcp();
    expect(fixture.environment["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  }, 30_000);
});
