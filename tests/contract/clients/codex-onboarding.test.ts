import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { CodexClientAdapter } from "../../../src/onboarding/adapters/clients/codex.js";
import {
  createCodexPluginManagerHarness,
  type CodexPluginManagerHarness,
} from "../../helpers/codex-plugin-manager-harness.js";

describe("Codex 0.147.0 clean normal-profile onboarding", () => {
  let fixture: OnboardingEnvironment | undefined;
  let pluginHarness: CodexPluginManagerHarness | undefined;
  afterEach(async () => {
    pluginHarness?.close();
    await fixture?.close();
  });

  it("preflights absent-name, adds optional user MCP, reads effective registration, and removes narrowly", async () => {
    fixture = await createOnboardingEnvironment();
    const launcher = resolve(fixture.root, "owned/bin/skillwire");
    await mkdir(resolve(fixture.root, "owned/bin"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const adapter = new CodexClientAdapter(
      resolve("node_modules/.bin/codex"),
      fixture.environment,
    );
    const before = await adapter.preflight();
    expect(before.version).toBe("0.147.0");
    expect(before.mcp).toBe("absent");
    await adapter.addMcp(launcher, "00000000-0000-4000-8000-000000000001");
    const registration = await adapter.readMcp();
    expect(registration).toMatchObject({
      enabled: true,
      command: launcher,
      args: [
        "bridge",
        "--installation",
        "00000000-0000-4000-8000-000000000001",
        "--client",
        "codex",
      ],
      env: null,
      envVars: [],
      cwd: null,
      required: false,
    });
    await adapter.removeMcp();
    expect((await adapter.preflight()).mcp).toBe("absent");
  });

  it("uses the real Codex plugin manager for marketplace/install/readback/remove independently of MCP", () => {
    pluginHarness = createCodexPluginManagerHarness();
    expect(pluginHarness.managerVersion).toBe("0.147.0");
    pluginHarness.addMarketplace();
    pluginHarness.installPlugin();
    expect(pluginHarness.listPlugins()).toEqual([
      expect.objectContaining({
        name: "skillwire-autonomous-activation",
        installed: true,
      }),
    ]);
    pluginHarness.removePlugin();
    pluginHarness.removeMarketplace();
    expect(pluginHarness.repositoryIsUnchanged()).toBe(true);
  });

  it("installs and removes the self-contained release-local plugin through the real manager", async () => {
    fixture = await createOnboardingEnvironment();
    const launcher = resolve(fixture.root, "owned/bin/skillwire");
    await mkdir(resolve(fixture.root, "owned/bin"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const adapter = new CodexClientAdapter(
      resolve("node_modules/.bin/codex"),
      fixture.environment,
    );
    await adapter.addMcp(launcher, "00000000-0000-4000-8000-000000000001");
    const marketplace = resolve("distribution/codex-release-marketplace");
    await adapter.addPlugin(marketplace);
    expect(await adapter.readPlugin(marketplace)).toMatchObject({
      pluginId: "skillwire-autonomous-activation@skillwire",
      marketplaceName: "skillwire",
      installed: true,
      enabled: true,
    });
    expect((await adapter.readMcp()).command).toBe(launcher);
    await adapter.removePlugin();
    await adapter.removeMcp();
  }, 30_000);

  it("keeps release-local behavior byte-identical to the versioned Feature 003 package", () => {
    for (const path of [
      "skills/autonomous-skill-activation/SKILL.md",
      "skills/autonomous-skill-activation/agents/openai.yaml",
    ]) {
      expect(
        readFileSync(
          resolve(
            "distribution/codex-release-marketplace/plugins/skillwire-autonomous-activation",
            path,
          ),
        ),
      ).toEqual(
        readFileSync(
          resolve("integrations/codex/skillwire-autonomous-activation", path),
        ),
      );
    }

    const releaseManifest = JSON.parse(
      readFileSync(
        resolve(
          "distribution/codex-release-marketplace/plugins/skillwire-autonomous-activation/.codex-plugin/plugin.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const canonicalManifest = JSON.parse(
      readFileSync(
        resolve(
          "integrations/codex/skillwire-autonomous-activation/.codex-plugin/plugin.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect({
      ...canonicalManifest,
      version: releaseManifest["version"],
    }).toEqual(releaseManifest);
  });
});
