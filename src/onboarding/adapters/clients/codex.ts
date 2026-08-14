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

const CodexStdioTransportSchema = z
  .object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.null(),
    env_vars: z.array(z.string()).length(0),
    cwd: z.null(),
  })
  .strict();

const CodexInventoryRegistrationSchema = z.looseObject({
  name: z.string().min(1),
  enabled: z.boolean(),
  disabled_reason: z.string().nullable(),
  transport: z.unknown(),
});

const CodexRegistrationSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean(),
    disabled_reason: z.string().nullable(),
    transport: CodexStdioTransportSchema,
    enabled_tools: z.unknown().optional(),
    disabled_tools: z.unknown().optional(),
    startup_timeout_sec: z.unknown().optional(),
    tool_timeout_sec: z.unknown().optional(),
    auth_status: z.unknown().optional(),
  })
  .strict();

const CodexPluginListSchema = z
  .object({
    installed: z.array(
      z
        .object({
          pluginId: z.literal("skillwire-autonomous-activation@skillwire"),
          name: z.literal("skillwire-autonomous-activation"),
          marketplaceName: z.literal("skillwire"),
          version: z.string().min(1).max(32),
          installed: z.literal(true),
          enabled: z.literal(true),
          source: z
            .object({ source: z.literal("local"), path: z.string().min(1) })
            .strict(),
          marketplaceSource: z
            .object({
              sourceType: z.literal("local"),
              source: z.string().min(1),
            })
            .strict(),
          installPolicy: z.string().min(1),
          authPolicy: z.string().min(1),
        })
        .strict(),
    ),
    available: z.array(z.unknown()),
  })
  .strict();

const CodexMarketplaceListSchema = z
  .object({
    marketplaces: z.array(
      z.looseObject({
        name: z.string().min(1),
        root: z.string().min(1),
        marketplaceSource: z.looseObject({
          sourceType: z.string().min(1),
          source: z.string().min(1),
        }),
      }),
    ),
  })
  .strict();

export interface CodexPluginRegistration {
  readonly pluginId: "skillwire-autonomous-activation@skillwire";
  readonly marketplaceName: "skillwire";
  readonly version: string;
  readonly installed: true;
  readonly enabled: true;
}

export interface ClientRegistration {
  readonly enabled: true;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: null;
  readonly envVars: readonly string[];
  readonly cwd: null;
  readonly required: false;
}

function cleanEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (environment["CODEX_HOME"] !== undefined)
    throw new Error("Codex onboarding must target the normal HOME profile");
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

export class CodexClientAdapter {
  public constructor(
    private readonly executable: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly signal?: AbortSignal,
  ) {
    if (!isAbsolute(executable))
      throw new Error("Codex executable must be absolute");
    cleanEnvironment(environment);
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

  async preflight(): Promise<{ version: string; mcp: "absent" | "present" }> {
    const versionResult = await this.run(["--version"]);
    const version = /codex-cli\s+(\S+)/.exec(versionResult.stdout)?.[1];
    if (version !== "0.147.0") throw new Error("Unsupported Codex version");
    const list = JSON.parse(
      (await this.run(["mcp", "list", "--json"])).stdout,
    ) as unknown;
    const entries = z.array(CodexInventoryRegistrationSchema).parse(list);
    return {
      version,
      mcp: entries.some(({ name }) => name === "skillwire")
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
      throw new Error("Codex MCP identity is invalid");
    const versionResult = await this.run(["--version"]);
    if (/codex-cli\s+(\S+)/.exec(versionResult.stdout)?.[1] !== "0.147.0")
      throw new Error("Unsupported Codex version");
    const entries = z
      .array(CodexInventoryRegistrationSchema)
      .parse(
        JSON.parse(
          (await this.run(["mcp", "list", "--json"])).stdout,
        ) as unknown,
      );
    const expectedIdentitySha256 = clientComponentIdentity({
      command: resolve(launcher),
      args: ["bridge", "--installation", installationId, "--client", "codex"],
      env: null,
      envVars: [],
      cwd: null,
      required: false,
    });
    return classifyClientComponent({
      requiredName: "skillwire",
      expectedIdentitySha256,
      ownedIdentitySha256,
      observations: entries.map((entry) => {
        const stdio = CodexStdioTransportSchema.safeParse(entry.transport);
        return {
          name: entry.name,
          scope: "user" as const,
          effective: entry.enabled,
          managed: false,
          disabled: !entry.enabled,
          identitySha256: stdio.success
            ? clientComponentIdentity({
                command: stdio.data.command,
                args: stdio.data.args,
                env: stdio.data.env,
                envVars: stdio.data.env_vars,
                cwd: stdio.data.cwd,
                required: false,
              })
            : clientComponentIdentity({ transport: entry.transport }),
        };
      }),
    });
  }

  async reconcilePlugin(
    marketplacePath: string,
  ): Promise<ClientComponentState> {
    if (!isAbsolute(marketplacePath))
      throw new Error("Codex marketplace path must be absolute");
    const expectedPath = resolve(marketplacePath);
    const marketplaces = CodexMarketplaceListSchema.parse(
      JSON.parse(
        (await this.run(["plugin", "marketplace", "list", "--json"])).stdout,
      ) as unknown,
    ).marketplaces;
    const namedMarketplace = marketplaces.filter(
      ({ name }) => name === "skillwire",
    );
    if (namedMarketplace.length === 0)
      return {
        classification: "absent",
        observations: [],
        mutationAllowed: true,
      };
    const marketplace = namedMarketplace[0];
    const marketplaceMatches =
      namedMarketplace.length === 1 &&
      marketplace?.marketplaceSource.sourceType === "local" &&
      resolve(marketplace.root) === expectedPath &&
      resolve(marketplace.marketplaceSource.source) === expectedPath;
    let pluginMatches = false;
    if (marketplaceMatches) {
      try {
        await this.readPlugin(expectedPath);
        pluginMatches = true;
      } catch {
        pluginMatches = false;
      }
    }
    const identitySha256 = clientComponentIdentity({
      marketplace: marketplaceMatches ? expectedPath : "conflicting",
      plugin: pluginMatches
        ? "skillwire-autonomous-activation@skillwire"
        : "unavailable",
    });
    return {
      classification:
        marketplaceMatches && pluginMatches
          ? "external-equivalent"
          : namedMarketplace.length > 1
            ? "duplicate"
            : "same-name-conflict",
      observations: [
        {
          name: "skillwire",
          scope: "plugin",
          effective: pluginMatches,
          managed: false,
          identitySha256,
        },
      ],
      mutationAllowed: false,
    };
  }

  async addMcp(launcher: string, installationId: string): Promise<void> {
    if (!isAbsolute(launcher) || !z.uuid().safeParse(installationId).success)
      throw new Error("Codex MCP identity is invalid");
    if (
      (await this.reconcileMcp(launcher, installationId)).classification !==
      "absent"
    )
      throw new ClientMutationNotStartedError(
        "mcp",
        "Refusing to replace or duplicate an existing Codex SkillWire MCP integration",
      );
    await this.run([
      "mcp",
      "add",
      "skillwire",
      "--",
      resolve(launcher),
      "bridge",
      "--installation",
      installationId,
      "--client",
      "codex",
    ]);
    const registration = await this.readMcp();
    if (
      registration.command !== resolve(launcher) ||
      registration.args.join("\0") !==
        ["bridge", "--installation", installationId, "--client", "codex"].join(
          "\0",
        )
    ) {
      throw new Error(
        "Codex effective MCP readback does not match the owned bridge",
      );
    }
  }

  async readMcp(): Promise<ClientRegistration> {
    const result = await this.run(["mcp", "get", "skillwire", "--json"]);
    const parsed = CodexRegistrationSchema.parse(
      JSON.parse(result.stdout) as unknown,
    );
    if (parsed.name !== "skillwire" || !parsed.enabled) {
      throw new Error("Codex returned the wrong MCP registration");
    }
    return {
      enabled: true,
      command: parsed.transport.command,
      args: parsed.transport.args,
      env: null,
      envVars: parsed.transport.env_vars,
      cwd: null,
      required: false,
    };
  }

  async addPlugin(
    marketplacePath: string,
    runMutation: ClientPluginMutationRunner = async (_component, action) =>
      action(),
  ): Promise<void> {
    if (!isAbsolute(marketplacePath))
      throw new Error("Codex marketplace path must be absolute");
    const state = await this.reconcilePlugin(marketplacePath);
    if (state.classification !== "absent")
      throw new ClientMutationNotStartedError(
        "plugin",
        "Refusing to replace or duplicate an existing Codex skillwire plugin integration",
      );
    await runMutation("marketplace-install", async () => {
      await this.run([
        "plugin",
        "marketplace",
        "add",
        resolve(marketplacePath),
        "--json",
      ]);
    });
    await runMutation("plugin-install", async () => {
      await this.run([
        "plugin",
        "add",
        "skillwire-autonomous-activation@skillwire",
        "--json",
      ]);
    });
    await this.readPlugin(marketplacePath);
    await this.readMcp();
  }

  async readPlugin(marketplacePath: string): Promise<CodexPluginRegistration> {
    if (!isAbsolute(marketplacePath))
      throw new Error("Codex marketplace path must be absolute");
    const result = await this.run([
      "plugin",
      "list",
      "--marketplace",
      "skillwire",
      "--json",
    ]);
    const plugins = CodexPluginListSchema.parse(
      JSON.parse(result.stdout) as unknown,
    ).installed;
    if (plugins.length !== 1)
      throw new Error("Codex plugin readback is missing or duplicated");
    const plugin = plugins[0];
    if (
      plugin === undefined ||
      resolve(plugin.marketplaceSource.source) !== resolve(marketplacePath) ||
      resolve(plugin.source.path) !==
        resolve(marketplacePath, "plugins/skillwire-autonomous-activation")
    ) {
      throw new Error("Codex plugin readback has the wrong release identity");
    }
    return {
      pluginId: plugin.pluginId,
      marketplaceName: plugin.marketplaceName,
      version: plugin.version,
      installed: plugin.installed,
      enabled: plugin.enabled,
    };
  }

  async readInventory(marketplacePath: string): Promise<{
    readonly mcp: ClientRegistration;
    readonly plugin: CodexPluginRegistration;
  }> {
    const [mcp, plugin] = await Promise.all([
      this.readMcp(),
      this.readPlugin(marketplacePath),
    ]);
    return { mcp, plugin };
  }

  async removePlugin(marketplacePath?: string): Promise<void> {
    await this.run([
      "plugin",
      "remove",
      "skillwire-autonomous-activation@skillwire",
      "--json",
    ]);
    await this.run(["plugin", "marketplace", "remove", "skillwire", "--json"]);
    if (
      marketplacePath !== undefined &&
      (await this.reconcilePlugin(marketplacePath)).classification !== "absent"
    ) {
      throw new Error("Codex did not remove the owned plugin integration");
    }
  }

  async removeMcp(): Promise<void> {
    await this.run(["mcp", "remove", "skillwire"]);
    const remaining = await this.run(
      ["mcp", "get", "skillwire", "--json"],
      [0, 1],
    );
    if (remaining.code === 0)
      throw new Error("Codex did not remove the MCP registration");
  }
}
