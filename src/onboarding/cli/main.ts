#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { routeAdministrativeCommand } from "./command-router.js";
import { runBridgeCommand } from "../../credential-bridge/bridge-cli.js";
import { redactText } from "./output.js";
import { createProductionLifecycleOperations } from "../application/production-lifecycle.js";

export type ClientName = "codex" | "claude";
export type CommandRoute =
  | "setup"
  | "status"
  | "doctor"
  | "clients:list"
  | "clients:install"
  | "clients:verify"
  | "clients:uninstall"
  | "clients:rotate-key"
  | "repair"
  | "backup"
  | "upgrade"
  | "maintenance:rotate-service-secret"
  | "uninstall"
  | "purge"
  | "bridge";

export interface ParsedCommand {
  readonly route: CommandRoute;
  readonly output: "human" | "json";
  readonly previewOnly: boolean;
  readonly confirmPreview?: string | undefined;
  readonly stateRoot?: string | undefined;
  readonly client?: ClientName | undefined;
  readonly clients?: "none" | "codex" | "claude" | "codex,claude" | undefined;
  readonly sources?:
    readonly ("mattpocock/skills" | "obra/superpowers")[] | undefined;
  readonly release?: string | undefined;
  readonly component?: string | undefined;
  readonly serviceSecret?:
    "database-password" | "application-pepper" | undefined;
  readonly installationId?: string | undefined;
}

export interface DispatcherIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface DispatcherDependencies {
  admin(
    command: ParsedCommand,
    io: DispatcherIo,
    signal: AbortSignal,
  ): Promise<number>;
  bridge(
    command: ParsedCommand,
    io: DispatcherIo,
    signal: AbortSignal,
  ): Promise<number>;
}

function expectValue(
  argv: readonly string[],
  index: number,
  name: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${name} requires one value`);
  return value;
}

function commonFlags(
  argv: readonly string[],
  start: number,
  allowed: ReadonlySet<string>,
): Omit<ParsedCommand, "route"> & { readonly positionals: readonly string[] } {
  let output: "human" | "json" = "human";
  let previewOnly = false;
  let confirmPreview: string | undefined;
  let stateRoot: string | undefined;
  let client: ClientName | undefined;
  let clients: ParsedCommand["clients"];
  let release: string | undefined;
  let component: string | undefined;
  const sources: ("mattpocock/skills" | "obra/superpowers")[] = [];
  const positionals: string[] = [];
  const seen = new Set<string>();
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (!allowed.has(token)) throw new Error(`Unsupported option: ${token}`);
    if (token !== "--source" && seen.has(token))
      throw new Error(`Repeated option: ${token}`);
    seen.add(token);
    if (token === "--preview-only") {
      previewOnly = true;
      continue;
    }
    const value = expectValue(argv, index, token);
    index += 1;
    if (token === "--output") {
      if (value !== "human" && value !== "json")
        throw new Error("--output must be human or json");
      output = value;
    } else if (token === "--confirm-preview") {
      if (!/^[0-9a-f]{64}$/.test(value))
        throw new Error("--confirm-preview must be a SHA-256 hash");
      confirmPreview = value;
    } else if (token === "--state-root") {
      if (!isAbsolute(value)) throw new Error("--state-root must be absolute");
      stateRoot = resolve(value);
    } else if (token === "--client") {
      if (value !== "codex" && value !== "claude")
        throw new Error("Unsupported client");
      client = value;
    } else if (token === "--clients") {
      if (!["none", "codex", "claude", "codex,claude"].includes(value))
        throw new Error("Unsupported client selection");
      clients = value as ParsedCommand["clients"];
    } else if (token === "--source") {
      if (value !== "mattpocock/skills" && value !== "obra/superpowers")
        throw new Error("Unsupported source");
      if (sources.includes(value)) throw new Error("Repeated source");
      sources.push(value);
    } else if (token === "--release") {
      if (!isAbsolute(value)) throw new Error("--release must be absolute");
      release = resolve(value);
    } else if (token === "--component") {
      if (!/^[a-z0-9][a-z0-9:._-]{0,127}$/.test(value))
        throw new Error("Invalid component ID");
      component = value;
    }
  }
  return {
    output,
    previewOnly,
    confirmPreview,
    stateRoot,
    client,
    clients,
    sources,
    release,
    component,
    positionals,
  };
}

const GLOBAL = [
  "--output",
  "--preview-only",
  "--confirm-preview",
  "--state-root",
] as const;

export function parseCommandLine(argv: readonly string[]): ParsedCommand {
  const first = argv[0];
  if (first === undefined) throw new Error("A command is required");
  if (first === "bridge") {
    const parsed = commonFlags(
      argv,
      1,
      new Set(["--installation", "--client"]),
    );
    if (parsed.positionals.length > 0 || parsed.client === undefined)
      throw new Error("Invalid bridge arguments");
    const installationIndex = argv.indexOf("--installation");
    const installationId =
      installationIndex < 0 ? undefined : argv[installationIndex + 1];
    if (
      installationId === undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        installationId,
      )
    ) {
      throw new Error("Bridge installation ID is invalid");
    }
    return { ...parsed, route: "bridge", installationId };
  }

  let route: CommandRoute;
  let start = 1;
  const allowed = new Set<string>(GLOBAL);
  if (["status", "doctor", "backup", "uninstall", "purge"].includes(first)) {
    route = first as "status" | "doctor" | "backup" | "uninstall" | "purge";
  } else if (first === "setup") {
    route = "setup";
    allowed.add("--clients");
    allowed.add("--source");
  } else if (first === "repair") {
    route = "repair";
    allowed.add("--component");
  } else if (first === "upgrade") {
    route = "upgrade";
    allowed.add("--release");
  } else if (first === "clients") {
    const action = argv[1];
    if (action === "list") {
      route = "clients:list";
      start = 2;
    } else if (
      ["install", "verify", "uninstall", "rotate-key"].includes(action ?? "")
    ) {
      route = `clients:${action as "install" | "verify" | "uninstall" | "rotate-key"}`;
      start = 3;
    } else throw new Error("Unsupported clients command");
  } else if (first === "maintenance" && argv[1] === "rotate-service-secret") {
    route = "maintenance:rotate-service-secret";
    start = 3;
  } else throw new Error(`Unsupported command: ${first}`);

  const parsed = commonFlags(argv, start, allowed);
  if (parsed.positionals.length > 0)
    throw new Error("Unexpected positional argument");
  let client = parsed.client;
  if (route.startsWith("clients:") && route !== "clients:list") {
    const value = argv[2];
    if (value !== "codex" && value !== "claude")
      throw new Error("A supported client is required");
    client = value;
  }
  const serviceSecret =
    route === "maintenance:rotate-service-secret" ? argv[2] : undefined;
  if (
    serviceSecret !== undefined &&
    serviceSecret !== "database-password" &&
    serviceSecret !== "application-pepper"
  ) {
    throw new Error("A supported service secret is required");
  }
  if (route === "upgrade" && parsed.release === undefined)
    throw new Error("upgrade requires --release");
  return {
    ...parsed,
    route,
    client,
    serviceSecret: serviceSecret,
  };
}

export function installCancellationSignals(
  controller: AbortController,
): () => void {
  const cancel = (): void => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  return () => {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  };
}

const defaultDependencies: DispatcherDependencies = {
  admin: (command, io, signal) =>
    routeAdministrativeCommand(
      command,
      io,
      signal,
      createProductionLifecycleOperations(process.env),
    ),
  bridge: runBridgeCommand,
};

export async function runDispatcher(
  argv: readonly string[],
  io: DispatcherIo,
  dependencies: DispatcherDependencies = defaultDependencies,
): Promise<number> {
  let command: ParsedCommand;
  try {
    command = parseCommandLine(argv);
  } catch (error) {
    io.stderr(
      `${redactText(error instanceof Error ? error.message : "Invalid invocation")}\n`,
    );
    return 2;
  }
  const controller = new AbortController();
  const dispose = installCancellationSignals(controller);
  try {
    return command.route === "bridge"
      ? await dependencies.bridge(command, io, controller.signal)
      : await dependencies.admin(command, io, controller.signal);
  } finally {
    dispose();
  }
}

async function main(): Promise<void> {
  const code = await runDispatcher(process.argv.slice(2), {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  });
  process.exitCode = code;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${redactText(error instanceof Error ? error.message : "SkillWire failed")}\n`,
    );
    process.exitCode = 1;
  });
}
