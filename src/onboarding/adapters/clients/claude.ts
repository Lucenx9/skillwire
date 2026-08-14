import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { runCommand } from "../process/command-runner.js";
import { ClientMutationNotStartedError } from "../../domain/client-mutation.js";
import {
  classifyClientComponent,
  clientComponentIdentity,
  type ClientPluginMutationRunner,
  type ClientComponentState,
} from "./client-state.js";

function cleanEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (environment["CLAUDE_CONFIG_DIR"] !== undefined)
    throw new Error("Claude onboarding must target the normal HOME profile");
  const allowed = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "PATH",
    "LANG",
    "LC_ALL",
  ] as const;
  return {
    ...Object.fromEntries(
      allowed.flatMap((key) =>
        environment[key] === undefined ? [] : [[key, environment[key]]],
      ),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

export interface ClaudeRegistration {
  readonly scope: "user";
  readonly command: string;
  readonly args: readonly string[];
}

export interface ClaudePluginRegistration {
  readonly pluginId: "skillwire-autonomous-activation@skillwire";
  readonly marketplaceName: "skillwire";
  readonly version: string;
  readonly enabled: true;
}

const ClaudeMarketplaceSchema = z
  .object({
    name: z.literal("skillwire"),
    plugins: z
      .array(
        z.looseObject({
          name: z.literal("skillwire-autonomous-activation"),
          version: z.string().min(1).max(32),
          source: z.literal("./plugins/skillwire-autonomous-activation"),
        }),
      )
      .length(1),
  })
  .loose();

const ClaudePluginManifestSchema = z
  .object({
    name: z.literal("skillwire-autonomous-activation"),
    version: z.string().min(1).max(32),
  })
  .loose();

function claudeMcpObservationIdentity(
  raw: unknown,
  scope: "user" | "project" | "managed",
): { readonly disabled: boolean; readonly identitySha256: string } {
  const stdio = z
    .looseObject({
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).default({}),
      disabled: z.boolean().optional(),
    })
    .safeParse(raw);
  if (!stdio.success) {
    const disabled = z
      .looseObject({ disabled: z.boolean().optional() })
      .safeParse(raw);
    return {
      disabled: disabled.success && disabled.data.disabled === true,
      identitySha256: clientComponentIdentity({ scope, transport: raw }),
    };
  }
  return {
    disabled: stdio.data.disabled === true,
    identitySha256: clientComponentIdentity({
      command: stdio.data.command,
      args: stdio.data.args,
      env: stdio.data.env,
      scope: "user",
    }),
  };
}

export class ClaudeClientAdapter {
  public constructor(
    private readonly executable: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly observationRoot: string = process.cwd(),
    private readonly managedMcpPath = "/etc/claude-code/managed-mcp.json",
    private readonly signal?: AbortSignal,
  ) {
    if (!isAbsolute(executable))
      throw new Error("Claude executable must be absolute");
    cleanEnvironment(environment);
    if (!isAbsolute(observationRoot) || !isAbsolute(managedMcpPath))
      throw new Error("Claude observation paths must be absolute");
  }

  private run(
    args: readonly string[],
    acceptExitCodes: readonly number[] = [0],
  ) {
    return runCommand({
      executable: resolve(this.executable),
      args,
      cwd: this.environment["HOME"],
      environment: cleanEnvironment(this.environment),
      acceptExitCodes,
      deadlineMilliseconds: 15_000,
      maximumOutputBytes: 256 * 1024,
      signal: this.signal,
    });
  }

  private profilePath(): string {
    const home = this.environment["HOME"];
    if (home === undefined || !isAbsolute(home))
      throw new Error("Claude onboarding requires an absolute HOME");
    return resolve(home, ".claude.json");
  }

  private settingsPath(): string {
    const home = this.environment["HOME"];
    if (home === undefined || !isAbsolute(home))
      throw new Error("Claude onboarding requires an absolute HOME");
    return resolve(home, ".claude/settings.json");
  }

  private async settingsRecord(): Promise<Record<string, unknown>> {
    let handle;
    try {
      handle = await open(
        this.settingsPath(),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return {};
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.uid !== process.getuid?.())
        throw new Error("Claude settings are unsafe");
      return JSON.parse((await handle.readFile()).toString("utf8")) as Record<
        string,
        unknown
      >;
    } finally {
      await handle.close();
    }
  }

  private async scopedMcpRecords(
    path: string,
    scope: "project" | "managed",
  ): Promise<
    {
      readonly name: string;
      readonly scope: "project" | "managed";
      readonly disabled: boolean;
      readonly identitySha256: string;
    }[]
  > {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
    try {
      const stats = await handle.stat();
      const allowedOwner =
        stats.uid === process.getuid?.() ||
        (scope === "managed" && stats.uid === 0);
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        !allowedOwner ||
        stats.size > 1024 * 1024
      )
        throw new Error("Claude scoped MCP inventory is unsafe");
      const parsed = z
        .looseObject({
          mcpServers: z.record(z.string(), z.unknown()).default({}),
        })
        .parse(
          JSON.parse((await handle.readFile()).toString("utf8")) as unknown,
        );
      return Object.entries(parsed.mcpServers).map(([name, raw]) => {
        const identity = claudeMcpObservationIdentity(raw, scope);
        return {
          name,
          scope,
          ...identity,
        };
      });
    } finally {
      await handle.close();
    }
  }

  private async ownedJsonFile(path: string): Promise<unknown> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        stats.size > 1024 * 1024
      ) {
        throw new Error("Claude release metadata is unsafe");
      }
      return JSON.parse((await handle.readFile()).toString("utf8")) as unknown;
    } finally {
      await handle.close();
    }
  }

  private async profileBytes(): Promise<Buffer | null> {
    try {
      const handle = await open(
        this.profilePath(),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.uid !== process.getuid?.())
          throw new Error("Claude profile is unsafe");
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }

  async preflight(): Promise<{ version: string; mcp: "absent" | "present" }> {
    const versionOutput = (await this.run(["--version"])).stdout;
    const version = /^(\S+)\s+\(Claude Code\)/m.exec(versionOutput)?.[1];
    if (version !== "2.1.229")
      throw new Error("Unsupported Claude Code version");
    const bytes = await this.profileBytes();
    const profile =
      bytes === null
        ? {}
        : (JSON.parse(bytes.toString("utf8")) as Record<string, unknown>);
    const servers = profile["mcpServers"];
    return {
      version,
      mcp:
        typeof servers === "object" &&
        servers !== null &&
        Object.hasOwn(servers, "skillwire")
          ? "present"
          : "absent",
    };
  }

  async reconcileMcp(
    launcher: string,
    installationId: string,
    ownedIdentitySha256?: string,
  ): Promise<ClientComponentState> {
    if (!isAbsolute(launcher) || !z.uuid().safeParse(installationId).success)
      throw new Error("Claude MCP identity is invalid");
    const versionOutput = (await this.run(["--version"])).stdout;
    if (/^(\S+)\s+\(Claude Code\)/m.exec(versionOutput)?.[1] !== "2.1.229")
      throw new Error("Unsupported Claude Code version");
    const bytes = await this.profileBytes();
    const profile =
      bytes === null
        ? {}
        : (JSON.parse(bytes.toString("utf8")) as Record<string, unknown>);
    const servers = profile["mcpServers"];
    const userRecords =
      typeof servers === "object" && servers !== null
        ? Object.entries(servers)
        : [];
    const [projectRecords, managedRecords] = await Promise.all([
      this.scopedMcpRecords(
        resolve(this.observationRoot, ".mcp.json"),
        "project",
      ),
      this.scopedMcpRecords(this.managedMcpPath, "managed"),
    ]);
    const expectedIdentitySha256 = clientComponentIdentity({
      command: resolve(launcher),
      args: ["bridge", "--installation", installationId, "--client", "claude"],
      env: {},
      scope: "user",
    });
    return classifyClientComponent({
      requiredName: "skillwire",
      expectedIdentitySha256,
      ownedIdentitySha256,
      observations: [
        ...userRecords.map(([name, raw]) => {
          const identity = claudeMcpObservationIdentity(raw, "user");
          return {
            name,
            scope: "user" as const,
            effective:
              !identity.disabled &&
              !projectRecords.some((entry) => entry.name === name) &&
              !managedRecords.some((entry) => entry.name === name),
            managed: false,
            ...identity,
          };
        }),
        ...projectRecords.map((entry) => ({
          name: entry.name,
          scope: "project" as const,
          effective:
            !entry.disabled &&
            !managedRecords.some((managed) => managed.name === entry.name),
          managed: false,
          disabled: entry.disabled,
          identitySha256: entry.identitySha256,
        })),
        ...managedRecords.map((entry) => ({
          name: entry.name,
          scope: "managed" as const,
          effective: !entry.disabled,
          managed: true,
          disabled: entry.disabled,
          identitySha256: entry.identitySha256,
        })),
      ],
    });
  }

  async reconcilePlugin(
    marketplacePath: string,
  ): Promise<ClientComponentState> {
    if (!isAbsolute(marketplacePath))
      throw new Error("Claude marketplace path must be absolute");
    const settings = await this.settingsRecord();
    const marketplaces = settings["extraKnownMarketplaces"];
    const marketplace =
      typeof marketplaces === "object" && marketplaces !== null
        ? (marketplaces as Record<string, unknown>)["skillwire"]
        : undefined;
    const enabledPlugins = settings["enabledPlugins"];
    const enabled =
      typeof enabledPlugins === "object" &&
      enabledPlugins !== null &&
      (enabledPlugins as Record<string, unknown>)[
        "skillwire-autonomous-activation@skillwire"
      ] === true;
    if (marketplace === undefined && !enabled)
      return {
        classification: "absent",
        observations: [],
        mutationAllowed: true,
      };
    const parsedMarketplace = z
      .looseObject({
        source: z.looseObject({
          source: z.literal("directory"),
          path: z.string().min(1),
        }),
      })
      .safeParse(marketplace);
    const matches =
      parsedMarketplace.success &&
      resolve(parsedMarketplace.data.source.path) ===
        resolve(marketplacePath) &&
      enabled;
    return {
      classification: matches ? "external-equivalent" : "same-name-conflict",
      observations: [
        {
          name: "skillwire",
          scope: "plugin",
          effective: enabled,
          managed: false,
          identitySha256: clientComponentIdentity({
            marketplace: parsedMarketplace.success
              ? resolve(parsedMarketplace.data.source.path)
              : "conflicting",
            plugin: enabled
              ? "skillwire-autonomous-activation@skillwire"
              : "unavailable",
          }),
        },
      ],
      mutationAllowed: false,
    };
  }

  async addMcp(launcher: string, installationId: string): Promise<void> {
    if (!isAbsolute(launcher) || !z.uuid().safeParse(installationId).success)
      throw new Error("Claude MCP identity is invalid");
    const beforeBytes = await this.profileBytes();
    const beforeProfile =
      beforeBytes === null
        ? {}
        : (JSON.parse(beforeBytes.toString("utf8")) as Record<string, unknown>);
    const beforeServers = beforeProfile["mcpServers"];
    if (
      typeof beforeServers === "object" &&
      beforeServers !== null &&
      Object.hasOwn(beforeServers, "skillwire")
    ) {
      throw new ClientMutationNotStartedError(
        "mcp",
        "Refusing to replace an existing Claude skillwire MCP entry",
      );
    }
    if (
      (await this.reconcileMcp(launcher, installationId)).classification !==
      "absent"
    ) {
      throw new ClientMutationNotStartedError(
        "mcp",
        "Refusing to replace or duplicate an existing Claude SkillWire MCP integration",
      );
    }
    await this.run([
      "mcp",
      "add",
      "--transport",
      "stdio",
      "--scope",
      "user",
      "skillwire",
      "--",
      resolve(launcher),
      "bridge",
      "--installation",
      installationId,
      "--client",
      "claude",
    ]);
    const registration = await this.readMcp();
    if (
      registration.command !== resolve(launcher) ||
      registration.args.join("\0") !==
        ["bridge", "--installation", installationId, "--client", "claude"].join(
          "\0",
        )
    ) {
      throw new Error(
        "Claude effective MCP readback does not match the owned bridge",
      );
    }
  }

  async readMcp(): Promise<ClaudeRegistration> {
    const bytes = await this.profileBytes();
    if (bytes === null) throw new Error("Claude MCP readback is incomplete");
    const profile = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    const servers = profile["mcpServers"];
    const raw =
      typeof servers === "object" && servers !== null
        ? (servers as Record<string, unknown>)["skillwire"]
        : undefined;
    const parsed = z
      .looseObject({
        type: z.literal("stdio").optional(),
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).default({}),
        disabled: z.boolean().optional(),
      })
      .parse(raw);
    if (parsed.disabled === true || Object.keys(parsed.env).length !== 0)
      throw new Error(
        "Claude MCP registration is not an optional clean STDIO entry",
      );
    return {
      scope: "user",
      command: parsed.command,
      args: parsed.args,
    };
  }

  async addPlugin(
    marketplacePath: string,
    runMutation: ClientPluginMutationRunner = async (_component, action) =>
      action(),
  ): Promise<void> {
    if (!isAbsolute(marketplacePath))
      throw new Error("Claude marketplace path must be absolute");
    const state = await this.reconcilePlugin(marketplacePath);
    if (state.classification !== "absent")
      throw new ClientMutationNotStartedError(
        "plugin",
        "Refusing to replace or duplicate an existing Claude skillwire plugin integration",
      );
    await runMutation("marketplace-install", async () => {
      await this.run([
        "plugin",
        "marketplace",
        "add",
        "--scope",
        "user",
        resolve(marketplacePath),
      ]);
    });
    await runMutation("plugin-install", async () => {
      await this.run([
        "plugin",
        "install",
        "skillwire-autonomous-activation@skillwire",
        "--scope",
        "user",
      ]);
    });
    await runMutation("plugin-enable", async () => {
      const enabled = await this.run(
        [
          "plugin",
          "enable",
          "skillwire-autonomous-activation@skillwire",
          "--scope",
          "user",
        ],
        [0, 1],
      );
      if (enabled.code !== 0 && !/already enabled/i.test(enabled.stderr)) {
        throw new Error("Claude plugin could not be enabled at user scope");
      }
    });
    await this.readPlugin(marketplacePath);
    await this.readMcp();
  }

  async readPlugin(marketplacePath: string): Promise<ClaudePluginRegistration> {
    if (!isAbsolute(marketplacePath))
      throw new Error("Claude marketplace path must be absolute");
    const state = await this.reconcilePlugin(marketplacePath);
    if (state.classification !== "external-equivalent") {
      throw new Error("Claude plugin readback has the wrong release identity");
    }
    const [marketplace, plugin] = await Promise.all([
      this.ownedJsonFile(
        resolve(marketplacePath, ".claude-plugin/marketplace.json"),
      ).then((value) => ClaudeMarketplaceSchema.parse(value)),
      this.ownedJsonFile(
        resolve(
          marketplacePath,
          "plugins/skillwire-autonomous-activation/.claude-plugin/plugin.json",
        ),
      ).then((value) => ClaudePluginManifestSchema.parse(value)),
    ]);
    const version = marketplace.plugins[0]?.version;
    if (version === undefined || plugin.version !== version)
      throw new Error("Claude plugin readback has the wrong release identity");
    return {
      pluginId: "skillwire-autonomous-activation@skillwire",
      marketplaceName: "skillwire",
      version,
      enabled: true,
    };
  }

  async readInventory(marketplacePath: string): Promise<{
    readonly mcp: ClaudeRegistration;
    readonly plugin: ClaudePluginRegistration;
  }> {
    const [mcp, plugin] = await Promise.all([
      this.readMcp(),
      this.readPlugin(marketplacePath),
    ]);
    return { mcp, plugin };
  }

  async removePlugin(): Promise<void> {
    await this.run([
      "plugin",
      "disable",
      "skillwire-autonomous-activation@skillwire",
      "--scope",
      "user",
    ]);
    await this.run([
      "plugin",
      "uninstall",
      "skillwire-autonomous-activation@skillwire",
      "--scope",
      "user",
    ]);
    await this.run([
      "plugin",
      "marketplace",
      "remove",
      "skillwire",
      "--scope",
      "user",
    ]);
    const settings = await this.settingsRecord();
    const enabled = settings["enabledPlugins"];
    const marketplaces = settings["extraKnownMarketplaces"];
    if (
      (typeof enabled === "object" &&
        enabled !== null &&
        Object.hasOwn(enabled, "skillwire-autonomous-activation@skillwire")) ||
      (typeof marketplaces === "object" &&
        marketplaces !== null &&
        Object.hasOwn(marketplaces, "skillwire"))
    ) {
      throw new Error("Claude did not remove the owned plugin integration");
    }
  }

  async removeMcp(): Promise<void> {
    const beforeBytes = await this.profileBytes();
    if (beforeBytes === null)
      throw new ClientMutationNotStartedError(
        "mcp",
        "Claude skillwire MCP entry is absent",
      );
    const before = JSON.parse(beforeBytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    const servers = before["mcpServers"];
    if (
      typeof servers !== "object" ||
      servers === null ||
      !Object.hasOwn(servers, "skillwire")
    ) {
      throw new ClientMutationNotStartedError(
        "mcp",
        "Claude skillwire MCP entry is absent",
      );
    }
    await this.run(["mcp", "remove", "skillwire", "--scope", "user"]);
    const afterBytes = await this.profileBytes();
    if (afterBytes === null) return;
    const after = JSON.parse(afterBytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    const afterServers = after["mcpServers"];
    if (
      typeof afterServers === "object" &&
      afterServers !== null &&
      Object.hasOwn(afterServers, "skillwire")
    ) {
      throw new Error("Claude did not remove the MCP registration");
    }
  }
}
