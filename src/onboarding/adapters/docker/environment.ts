import { isAbsolute } from "node:path";

import {
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "../process/command-runner.js";

const ROUTING_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
] as const;

function safeRoutingValue(key: (typeof ROUTING_KEYS)[number], value: string) {
  if (value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value))
    throw new Error(`Docker ${key} routing value is invalid`);
  if (
    (key === "HOME" ||
      key === "XDG_CONFIG_HOME" ||
      key === "XDG_RUNTIME_DIR" ||
      key === "DOCKER_CONFIG" ||
      key === "DOCKER_CERT_PATH") &&
    !isAbsolute(value)
  )
    throw new Error(`Docker ${key} path must be absolute`);
  if (
    key === "DOCKER_HOST" &&
    !value.startsWith("unix://") &&
    !value.startsWith("npipe://")
  )
    throw new Error("Only a local Docker endpoint is supported");
  if (
    key === "DOCKER_CONTEXT" &&
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
  )
    throw new Error("Docker context name is invalid");
  if (key === "DOCKER_TLS_VERIFY" && value !== "0" && value !== "1")
    throw new Error("Docker TLS routing value is invalid");
  return value;
}

export function dockerProcessEnvironment(
  ambient: NodeJS.ProcessEnv,
  explicit: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
  for (const key of ROUTING_KEYS) {
    const value = ambient[key];
    if (value !== undefined) result[key] = safeRoutingValue(key, value);
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (
      !/^SKILLWIRE_[A-Z0-9_]{1,96}$/.test(key) ||
      value.length === 0 ||
      value.length > 4096 ||
      /[\0\r\n]/.test(value)
    )
      throw new Error("Explicit Docker Compose environment is invalid");
    result[key] = value;
  }
  return result;
}

export async function assertLocalDockerContext(options: {
  readonly dockerExecutable: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly run?:
    ((options: CommandOptions) => Promise<CommandResult>) | undefined;
}): Promise<string> {
  if (!isAbsolute(options.dockerExecutable))
    throw new Error("Docker executable must be absolute");
  if (options.signal.aborted) throw new Error("Docker context check cancelled");
  const routedEnvironment = dockerProcessEnvironment(options.environment);
  if (options.environment["DOCKER_CONTEXT"] === undefined) {
    const explicitHost = routedEnvironment["DOCKER_HOST"];
    if (explicitHost !== undefined) return explicitHost;
  }
  const run = options.run ?? runCommand;
  const command = (args: readonly string[]) =>
    run({
      executable: options.dockerExecutable,
      args,
      environment: routedEnvironment,
      deadlineMilliseconds: 10_000,
      maximumOutputBytes: 16 * 1024,
      signal: options.signal,
    });
  const context = (await command(["context", "show"])).stdout.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context))
    throw new Error("Effective Docker context identity is invalid");
  const endpoint = (
    await command([
      "context",
      "inspect",
      context,
      "--format",
      "{{.Endpoints.docker.Host}}",
    ])
  ).stdout.trim();
  if (
    endpoint.length === 0 ||
    endpoint.length > 4096 ||
    /[\0\r\n]/.test(endpoint) ||
    (!endpoint.startsWith("unix://") && !endpoint.startsWith("npipe://"))
  )
    throw new Error(
      "A local Docker context is required; remote contexts are refused",
    );
  return endpoint;
}

export function pinLocalDockerEndpoint(
  environment: NodeJS.ProcessEnv,
  endpoint: string,
): NodeJS.ProcessEnv {
  const pinned: NodeJS.ProcessEnv = { ...environment, DOCKER_HOST: endpoint };
  delete pinned["DOCKER_CONTEXT"];
  return pinned;
}
