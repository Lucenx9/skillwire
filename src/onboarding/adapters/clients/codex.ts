import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { runCommand } from "../process/command-runner.js";
import { ClientMutationNotStartedError } from "../../domain/client-mutation.js";

const CodexRegistrationSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.literal(true),
    disabled_reason: z.null(),
    transport: z
      .object({
        type: z.literal("stdio"),
        command: z.string().min(1),
        args: z.array(z.string()),
        env: z.null(),
        env_vars: z.array(z.string()).length(0),
        cwd: z.null(),
      })
      .strict(),
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
  return { ...environment, NO_COLOR: "1", TERM: "dumb" };
}

export class CodexClientAdapter {
  public constructor(
    private readonly executable: string,
    private readonly environment: NodeJS.ProcessEnv,
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
      environment: cleanEnvironment(this.environment),
      acceptExitCodes,
      deadlineMilliseconds: 15_000,
      maximumOutputBytes: 256 * 1024,
    });
  }

  async preflight(): Promise<{ version: string; mcp: "absent" | "present" }> {
    const versionResult = await this.run(["--version"]);
    const version = /codex-cli\s+(\S+)/.exec(versionResult.stdout)?.[1];
    if (version !== "0.147.0") throw new Error("Unsupported Codex version");
    const list = JSON.parse(
      (await this.run(["mcp", "list", "--json"])).stdout,
    ) as unknown;
    const entries = z.array(CodexRegistrationSchema).parse(list);
    return {
      version,
      mcp: entries.some(({ name }) => name === "skillwire")
        ? "present"
        : "absent",
    };
  }

  async addMcp(launcher: string, installationId: string): Promise<void> {
    if (!isAbsolute(launcher) || !z.uuid().safeParse(installationId).success)
      throw new Error("Codex MCP identity is invalid");
    if ((await this.preflight()).mcp !== "absent")
      throw new ClientMutationNotStartedError(
        "mcp",
        "Refusing to replace an existing Codex skillwire MCP entry",
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
    if (parsed.name !== "skillwire") {
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

  async addPlugin(marketplacePath: string): Promise<void> {
    if (!isAbsolute(marketplacePath))
      throw new Error("Codex marketplace path must be absolute");
    await this.run([
      "plugin",
      "marketplace",
      "add",
      resolve(marketplacePath),
      "--json",
    ]);
    await this.run([
      "plugin",
      "add",
      "skillwire-autonomous-activation@skillwire",
      "--json",
    ]);
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

  async removePlugin(): Promise<void> {
    await this.run([
      "plugin",
      "remove",
      "skillwire-autonomous-activation@skillwire",
      "--json",
    ]);
    await this.run(["plugin", "marketplace", "remove", "skillwire", "--json"]);
  }

  async removeMcp(): Promise<void> {
    await this.run(["mcp", "remove", "skillwire"]);
  }
}
