import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CODEX_ADAPTER_SOURCE_COMMIT } from "../../../src/evaluation/codex-adapter-package.js";
import {
  createCodexPluginManagerHarness,
  type CodexPluginManagerHarness,
} from "../../helpers/codex-plugin-manager-harness.js";

function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    throw new Error(`expected a stable semantic version, received ${version}`);
  }
  return `${match[1]}.${match[2]}.${String(Number(match[3]) + 1)}`;
}

describe("Codex activation plugin manager lifecycle", () => {
  const harnesses: CodexPluginManagerHarness[] = [];

  afterEach(() => {
    harnesses.splice(0).forEach((harness) => {
      harness.close();
    });
  });

  it("adds, lists, installs, and verifies one adapter in a disposable profile", () => {
    const harness = createCodexPluginManagerHarness();
    harnesses.push(harness);

    expect(harness.managerVersion).toBe("0.147.0");
    if (existsSync(join(process.cwd(), ".git"))) {
      expect(harness.sourceCommit).toBe(CODEX_ADAPTER_SOURCE_COMMIT);
    } else {
      expect(harness.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(harness.profileModes()).toEqual({ home: 0o700, codexHome: 0o700 });

    harness.addMarketplace();
    expect(harness.listMarketplaces()).toEqual([
      expect.objectContaining({ name: "skillwire" }),
    ]);
    expect(harness.listPlugins({ available: true })).toEqual([
      expect.objectContaining({
        name: "skillwire-autonomous-activation",
        marketplaceName: "skillwire",
        installed: false,
      }),
    ]);

    harness.installPlugin();
    const installedVersion = harness.installedVersion();
    expect(installedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    if (installedVersion === undefined) {
      throw new Error("expected an installed plugin version");
    }
    expect(harness.listPlugins()).toEqual([
      expect.objectContaining({
        name: "skillwire-autonomous-activation",
        marketplaceName: "skillwire",
        installed: true,
        version: installedVersion,
      }),
    ]);
    expect(harness.effectiveInventory()).toEqual({
      pluginSkills: [
        "skillwire-autonomous-activation:autonomous-skill-activation",
      ],
      mcpServers: ["skillwire"],
      installedPluginCount: 1,
    });
    expect(harness.installedPackageMatchesSource()).toBe(true);
    expect(harness.profileContainsRemoteSkillContent()).toBe(false);
    expect(harness.outputsContainCredential()).toBe(false);
    expect(harness.repositoryIsUnchanged()).toBe(true);
  });

  it.each([
    { state: "manager-added", configuredMcp: undefined },
    { state: "absent", configuredMcp: undefined },
    { state: "unavailable", configuredMcp: undefined },
    { state: "unauthenticated", configuredMcp: undefined },
    { state: "incompatible", configuredMcp: undefined },
    { state: "rate-limited", configuredMcp: undefined },
    { state: "timed-out", configuredMcp: undefined },
    { state: "equivalent-existing", configuredMcp: "equivalent" },
    { state: "name-conflict", configuredMcp: "conflict" },
  ] as const)(
    "fails open without duplicate binding or retry for $state",
    ({ state, configuredMcp }) => {
      const harness = createCodexPluginManagerHarness(
        configuredMcp === undefined ? {} : { configuredMcp },
      );
      harnesses.push(harness);
      harness.addMarketplace();
      harness.installPlugin();

      const behavior = harness.dependencyBehavior(state);
      expect(behavior).toEqual({
        state,
        effectiveBindingCount: 1,
        automaticAttempts:
          state === "absent" || state === "name-conflict" ? 0 : 1,
        retries: 0,
        configurationOverwritten: false,
        ordinaryWorkContinues: true,
        explicitMcpPreserved:
          configuredMcp === "equivalent" || configuredMcp === "conflict",
      });
      expect(harness.configuredMcpIsUnchanged()).toBe(true);
      expect(harness.outputsContainCredential()).toBe(false);
      expect(harness.repositoryIsUnchanged()).toBe(true);
    },
  );

  it("keeps the last valid adapter on invalid upgrade, then replaces it on valid upgrade", () => {
    const harness = createCodexPluginManagerHarness();
    harnesses.push(harness);
    harness.addMarketplace();
    harness.installPlugin();

    const initialVersion = harness.installedVersion();
    expect(initialVersion).toMatch(/^\d+\.\d+\.\d+$/);
    if (initialVersion === undefined) {
      throw new Error("expected an installed plugin version");
    }
    expect(harness.installedVersion()).toBe(initialVersion);
    expect(harness.attemptInterruptedUpgrade()).toBe(false);
    expect(harness.installedVersion()).toBe(initialVersion);
    expect(harness.attemptInvalidUpgrade()).toBe(false);
    expect(harness.installedVersion()).toBe(initialVersion);
    expect(harness.installedPackageMatchesSource()).toBe(true);

    const upgradedVersion = nextPatchVersion(initialVersion);
    harness.upgradePlugin(upgradedVersion);
    expect(harness.installedVersion()).toBe(upgradedVersion);
    expect(harness.installedPackageMatchesSource()).toBe(true);
    expect(harness.effectiveInventory().installedPluginCount).toBe(1);
    expect(harness.repositoryIsUnchanged()).toBe(true);
  });

  it("removes only manager-owned adapter state and preserves independent MCP configuration", () => {
    const harness = createCodexPluginManagerHarness({
      configuredMcp: "equivalent",
    });
    harnesses.push(harness);
    harness.addMarketplace();
    harness.installPlugin();
    expect(harness.adapterOwnedFileCount()).toBe(3);

    harness.removePlugin();
    expect(harness.adapterOwnedFileCount()).toBe(0);
    expect(harness.effectiveInventory()).toEqual({
      pluginSkills: [],
      mcpServers: ["skillwire"],
      installedPluginCount: 0,
    });
    expect(harness.configuredMcpIsUnchanged()).toBe(true);
    harness.removeMarketplace();
    expect(harness.listMarketplaces()).toEqual([]);
    expect(harness.outputsContainCredential()).toBe(false);
    expect(harness.profileContainsRemoteSkillContent()).toBe(false);
    expect(harness.repositoryIsUnchanged()).toBe(true);
  });
});
