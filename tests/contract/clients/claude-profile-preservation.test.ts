import { readFile, stat, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeClientAdapter } from "../../../src/onboarding/adapters/clients/claude.js";
import { classifyClientComponent } from "../../../src/onboarding/adapters/clients/client-state.js";
import {
  CLIENT_COMPONENT_OBSERVATION_FIXTURES,
  EXPECTED_CLIENT_COMPONENT_IDENTITY,
  createClientProfileFixture,
  semanticJson,
  snapshotTree,
  type ClientProfileFixture,
} from "../../helpers/client-profile-fixtures.js";

const installationId = "00000000-0000-4000-8000-000000000001";

async function exactFileIdentity(path: string): Promise<string> {
  const value = await stat(path, { bigint: true });
  return [value.dev, value.ino, value.size, value.mode, value.mtimeNs].join(
    ":",
  );
}

describe("Claude populated normal-profile preservation", () => {
  let fixture: ClientProfileFixture | undefined;
  afterEach(async () => fixture?.close());

  it("uses explicit user scope and preserves unrelated semantic profile/settings state", async () => {
    fixture = await createClientProfileFixture();
    const before = semanticJson(await readFile(fixture.claudeConfig, "utf8"));
    const settingsBefore = await readFile(fixture.claudeSettings, "utf8");
    const repositoryBefore = await snapshotTree(fixture.repository);
    const adapter = new ClaudeClientAdapter(
      "/usr/bin/claude",
      fixture.environment,
    );
    await adapter.addMcp(fixture.launcher, installationId);
    const after = semanticJson(
      await readFile(fixture.claudeConfig, "utf8"),
    ) as {
      mcpServers: Record<string, unknown>;
      [key: string]: unknown;
    };
    const beforeRecord = before as {
      mcpServers: Record<string, unknown>;
      [key: string]: unknown;
    };
    const { skillwire: _added, ...unrelatedAfter } = after.mcpServers;
    const externalBytes = await readFile(fixture.claudeConfig);
    const externalIdentity = await exactFileIdentity(fixture.claudeConfig);
    expect({ ...after, mcpServers: unrelatedAfter }).toEqual(beforeRecord);
    expect(await adapter.readMcp()).toMatchObject({ scope: "user" });
    expect(
      (await adapter.reconcileMcp(fixture.launcher, installationId))
        .classification,
    ).toBe("external-equivalent");
    expect(await readFile(fixture.claudeConfig)).toEqual(externalBytes);
    expect(await exactFileIdentity(fixture.claudeConfig)).toBe(
      externalIdentity,
    );
    expect(await readFile(fixture.claudeSettings, "utf8")).toBe(settingsBefore);
    expect(await snapshotTree(fixture.repository)).toEqual(repositoryBefore);
  }, 30_000);

  it("classifies managed and shadowed effective state without profile mutation", async () => {
    fixture = await createClientProfileFixture();
    const before = await readFile(fixture.claudeConfig, "utf8");
    expect(
      classifyClientComponent({
        requiredName: "skillwire",
        expectedIdentitySha256: EXPECTED_CLIENT_COMPONENT_IDENTITY,
        observations: CLIENT_COMPONENT_OBSERVATION_FIXTURES.shadowed,
      }).classification,
    ).toBe("shadowed");
    expect(
      classifyClientComponent({
        requiredName: "skillwire",
        expectedIdentitySha256: EXPECTED_CLIENT_COMPONENT_IDENTITY,
        observations: CLIENT_COMPONENT_OBSERVATION_FIXTURES.managed,
      }).classification,
    ).toBe("managed");
    expect(await readFile(fixture.claudeConfig, "utf8")).toBe(before);

    const managedPath = `${fixture.root}/managed-mcp.json`;
    const adapter = new ClaudeClientAdapter(
      "/usr/bin/claude",
      fixture.environment,
      fixture.repository,
      managedPath,
    );
    await adapter.addMcp(fixture.launcher, installationId);
    await writeFile(
      `${fixture.repository}/.mcp.json`,
      `${JSON.stringify({
        mcpServers: {
          skillwire: {
            command: "/bin/false",
            args: ["project"],
            env: {},
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    expect(
      (await adapter.reconcileMcp(fixture.launcher, installationId))
        .classification,
    ).toBe("shadowed");
    await writeFile(
      managedPath,
      `${JSON.stringify({
        mcpServers: {
          skillwire: {
            command: "/bin/false",
            args: ["managed"],
            env: {},
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    expect(
      (await adapter.reconcileMcp(fixture.launcher, installationId))
        .classification,
    ).toBe("managed");
  }, 30_000);

  it("blocks a conflicting user entry without rewriting it", async () => {
    fixture = await createClientProfileFixture();
    const profile = semanticJson(
      await readFile(fixture.claudeConfig, "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    profile.mcpServers["skillwire"] = {
      type: "stdio",
      command: "/bin/false",
      args: ["external"],
      env: {},
    };
    const bytes = `${JSON.stringify(profile, null, 2)}\n`;
    await writeFile(fixture.claudeConfig, bytes, { mode: 0o600 });
    const adapter = new ClaudeClientAdapter(
      "/usr/bin/claude",
      fixture.environment,
    );

    expect(
      (await adapter.reconcileMcp(fixture.launcher, installationId))
        .classification,
    ).toBe("same-name-conflict");

    await expect(
      adapter.addMcp(fixture.launcher, installationId),
    ).rejects.toThrow(/replace|conflict/i);
    expect(await readFile(fixture.claudeConfig, "utf8")).toBe(bytes);
  });

  it("preserves unrelated profile and settings state through plugin add/remove", async () => {
    fixture = await createClientProfileFixture();
    const adapter = new ClaudeClientAdapter(
      "/usr/bin/claude",
      fixture.environment,
    );
    const originalProfile = semanticJson(
      await readFile(fixture.claudeConfig, "utf8"),
    );
    await adapter.addMcp(fixture.launcher, installationId);
    const profileBefore = semanticJson(
      await readFile(fixture.claudeConfig, "utf8"),
    );
    const settingsBefore = semanticJson(
      await readFile(fixture.claudeSettings, "utf8"),
    ) as Record<string, unknown>;
    const marketplace = new URL(
      "../../../distribution/claude-marketplace",
      import.meta.url,
    ).pathname;

    await adapter.addPlugin(marketplace);
    const externalProfileBytes = await readFile(fixture.claudeConfig);
    const externalProfileIdentity = await exactFileIdentity(
      fixture.claudeConfig,
    );
    await expect(adapter.readPlugin(marketplace)).resolves.toMatchObject({
      pluginId: "skillwire-autonomous-activation@skillwire",
      marketplaceName: "skillwire",
      enabled: true,
    });
    expect(await readFile(fixture.claudeConfig)).toEqual(externalProfileBytes);
    expect(await exactFileIdentity(fixture.claudeConfig)).toBe(
      externalProfileIdentity,
    );
    expect((await adapter.reconcilePlugin(marketplace)).classification).toBe(
      "external-equivalent",
    );
    expect(semanticJson(await readFile(fixture.claudeConfig, "utf8"))).toEqual(
      profileBefore,
    );
    const settingsAfterAdd = semanticJson(
      await readFile(fixture.claudeSettings, "utf8"),
    ) as Record<string, unknown>;
    expect(settingsAfterAdd["enabledPlugins"]).toMatchObject({
      "unrelated@fixture": true,
      "skillwire-autonomous-activation@skillwire": true,
    });
    expect(settingsAfterAdd["extraKnownMarketplaces"]).toMatchObject({
      skillwire: { source: { source: "directory", path: marketplace } },
    });
    const {
      enabledPlugins: _enabled,
      extraKnownMarketplaces: _marketplaces,
      ...unrelatedSettings
    } = settingsAfterAdd;
    const { enabledPlugins: _beforeEnabled, ...beforeWithoutEnabled } =
      settingsBefore;
    expect(unrelatedSettings).toEqual(beforeWithoutEnabled);

    await adapter.removePlugin();
    expect(semanticJson(await readFile(fixture.claudeConfig, "utf8"))).toEqual(
      profileBefore,
    );
    expect(
      semanticJson(await readFile(fixture.claudeSettings, "utf8")),
    ).toEqual(settingsBefore);
    await adapter.removeMcp();
    expect(semanticJson(await readFile(fixture.claudeConfig, "utf8"))).toEqual(
      originalProfile,
    );
  }, 30_000);
});
