import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { runCommand } from "../process/command-runner.js";
import { ClientMutationNotStartedError } from "../../domain/client-mutation.js";

function cleanEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (environment["CLAUDE_CONFIG_DIR"] !== undefined)
    throw new Error("Claude onboarding must target the normal HOME profile");
  return { ...environment, NO_COLOR: "1", TERM: "dumb" };
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

export class ClaudeClientAdapter {
  public constructor(
    private readonly executable: string,
    private readonly environment: NodeJS.ProcessEnv,
  ) {
    if (!isAbsolute(executable))
      throw new Error("Claude executable must be absolute");
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
    const versionOutput = (await this.run(["--version"])).stdout;
    const version = /^(\S+)\s+\(Claude Code\)/m.exec(versionOutput)?.[1];
    if (version !== "2.1.229")
      throw new Error("Unsupported Claude Code version");
    const result = await this.run(["mcp", "get", "skillwire"], [0, 1]);
    return {
      version,
      mcp:
        result.code === 0 && /Scope:\s+User config/i.test(result.stdout)
          ? "present"
          : "absent",
    };
  }

  async addMcp(launcher: string, installationId: string): Promise<void> {
    if (!isAbsolute(launcher) || !z.uuid().safeParse(installationId).success)
      throw new Error("Claude MCP identity is invalid");
    if ((await this.preflight()).mcp !== "absent")
      throw new ClientMutationNotStartedError(
        "mcp",
        "Refusing to replace an existing Claude skillwire MCP entry",
      );
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
    const output = (await this.run(["mcp", "get", "skillwire"])).stdout;
    if (!/Scope:\s+User config/i.test(output))
      throw new Error("Claude MCP registration is not user-scoped");
    const command = /^\s*Command:\s*(.+)$/im.exec(output)?.[1]?.trim();
    const args = /^\s*Args:\s*(.*)$/im.exec(output)?.[1]?.trim();
    if (command === undefined || args === undefined)
      throw new Error("Claude MCP readback is incomplete");
    return {
      scope: "user",
      command,
      args: args === "" ? [] : args.split(/\s+/),
    };
  }

  async addPlugin(marketplacePath: string): Promise<void> {
    if (!isAbsolute(marketplacePath))
      throw new Error("Claude marketplace path must be absolute");
    await this.run([
      "plugin",
      "marketplace",
      "add",
      "--scope",
      "user",
      resolve(marketplacePath),
    ]);
    await this.run([
      "plugin",
      "install",
      "skillwire-autonomous-activation@skillwire",
      "--scope",
      "user",
    ]);
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
    await this.readPlugin(marketplacePath);
    await this.readMcp();
  }

  async readPlugin(marketplacePath: string): Promise<ClaudePluginRegistration> {
    if (!isAbsolute(marketplacePath))
      throw new Error("Claude marketplace path must be absolute");
    const output = (
      await this.run([
        "plugin",
        "details",
        "skillwire-autonomous-activation@skillwire",
      ])
    ).stdout;
    const version = /^skillwire-autonomous-activation\s+(\S+)\s*$/m.exec(
      output,
    )?.[1];
    if (
      version === undefined ||
      !/^\s*Source:\s+skillwire-autonomous-activation@skillwire\s*$/m.test(
        output,
      ) ||
      !/^\s*Skills \(1\)\s+autonomous-skill-activation\s*$/m.test(output) ||
      !/^\s*MCP servers \(0\)\s*$/m.test(output)
    ) {
      throw new Error("Claude plugin readback has the wrong release identity");
    }
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
  }

  async removeMcp(): Promise<void> {
    await this.run(["mcp", "remove", "skillwire", "--scope", "user"]);
  }
}
