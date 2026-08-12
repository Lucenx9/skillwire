import { afterEach, describe, expect, it } from "vitest";

import {
  createCodexPluginManagerHarness,
  type CodexPluginManagerHarness,
} from "../../helpers/codex-plugin-manager-harness.js";

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
    expect(harness.listPlugins()).toEqual([
      expect.objectContaining({
        name: "skillwire-autonomous-activation",
        marketplaceName: "skillwire",
        installed: true,
        version: "0.1.0",
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

    expect(harness.installedVersion()).toBe("0.1.0");
    expect(harness.attemptInterruptedUpgrade()).toBe(false);
    expect(harness.installedVersion()).toBe("0.1.0");
    expect(harness.attemptInvalidUpgrade()).toBe(false);
    expect(harness.installedVersion()).toBe("0.1.0");
    expect(harness.installedPackageMatchesSource()).toBe(true);

    harness.upgradePlugin("0.1.1");
    expect(harness.installedVersion()).toBe("0.1.1");
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
