import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import {
  CODEX_ADAPTER_FILES,
  CODEX_ADAPTER_PLUGIN_NAME,
  CODEX_ADAPTER_SOURCE_PATH,
  validateCodexAdapterPackage,
} from "../../src/evaluation/codex-adapter-package.js";

const PLUGIN_SELECTOR = `${CODEX_ADAPTER_PLUGIN_NAME}@skillwire`;
const FIXTURE_MARKETPLACE_URL = "https://fixture.invalid/marketplace.git";
const FIXTURE_PLUGIN_URL = "https://fixture.invalid/plugin.git";
const FIXTURE_CREDENTIAL = "fixture-protected-value-never-print";

export interface NormalizedMarketplace {
  readonly name: string;
}

export interface NormalizedPlugin {
  readonly name: string;
  readonly marketplaceName: string;
  readonly installed: boolean;
  readonly version?: string;
}

export type DependencyScenario =
  | "equivalent-existing"
  | "manager-added"
  | "absent"
  | "name-conflict"
  | "unavailable"
  | "unauthenticated"
  | "incompatible"
  | "rate-limited"
  | "timed-out";

export interface DependencyBehavior {
  readonly state: DependencyScenario;
  readonly effectiveBindingCount: number;
  readonly automaticAttempts: 0 | 1;
  readonly retries: 0;
  readonly configurationOverwritten: false;
  readonly ordinaryWorkContinues: true;
  readonly explicitMcpPreserved: boolean;
}

export interface CodexPluginManagerHarnessOptions {
  readonly configuredMcp?: "equivalent" | "conflict";
}

export interface CodexPluginManagerHarness {
  readonly managerVersion: string;
  readonly sourceCommit: string;
  addMarketplace(): void;
  listMarketplaces(): readonly NormalizedMarketplace[];
  listPlugins(options?: {
    readonly available?: boolean;
  }): readonly NormalizedPlugin[];
  installPlugin(): void;
  attemptInterruptedUpgrade(): boolean;
  attemptInvalidUpgrade(): boolean;
  upgradePlugin(version: "0.1.1"): void;
  installedVersion(): string | undefined;
  removePlugin(): void;
  removeMarketplace(): void;
  adapterOwnedFileCount(): number;
  dependencyBehavior(state: DependencyScenario): DependencyBehavior;
  configuredMcpIsUnchanged(): boolean;
  effectiveInventory(): {
    readonly pluginSkills: readonly string[];
    readonly mcpServers: readonly string[];
    readonly installedPluginCount: number;
  };
  installedPackageMatchesSource(): boolean;
  profileContainsRemoteSkillContent(): boolean;
  outputsContainCredential(): boolean;
  repositoryIsUnchanged(): boolean;
  profileModes(): { readonly home: number; readonly codexHome: number };
  close(): void;
}

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly json?: unknown;
}

class Harness implements CodexPluginManagerHarness {
  readonly #root: string;
  readonly #home: string;
  readonly #codexHome: string;
  readonly #repository: string;
  readonly #pluginRepository: string;
  readonly #marketplaceRepository: string;
  readonly #marketplacePath: string;
  readonly #gitConfig: string;
  readonly #managerPath: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #outputs: CommandResult[] = [];
  readonly #initialRepositoryDigest: string;
  readonly #configuredMcp: CodexPluginManagerHarnessOptions["configuredMcp"];
  readonly #initialMcpSnapshot: string;
  #currentSourceCommit: string;
  readonly managerVersion: string;

  get sourceCommit(): string {
    return this.#currentSourceCommit;
  }

  constructor(options: CodexPluginManagerHarnessOptions = {}) {
    this.#configuredMcp = options.configuredMcp;
    const projectRoot = process.cwd();
    this.#root = mkdtempSync(join(tmpdir(), "skillwire-codex-plugin-"));
    chmodSync(this.#root, 0o700);
    this.#home = join(this.#root, "home");
    this.#codexHome = join(this.#root, "codex-home");
    this.#repository = join(this.#root, "empty-repository");
    this.#pluginRepository = join(this.#root, "plugin-source");
    this.#marketplaceRepository = join(this.#root, "marketplace-source");
    this.#gitConfig = join(this.#root, "gitconfig");
    for (const directory of [
      this.#home,
      this.#codexHome,
      this.#repository,
      this.#pluginRepository,
      this.#marketplaceRepository,
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    const pluginRoot = join(
      projectRoot,
      "integrations/codex/skillwire-autonomous-activation",
    );
    validateCodexAdapterPackage(pluginRoot);
    const pluginDestination = join(
      this.#pluginRepository,
      CODEX_ADAPTER_SOURCE_PATH.slice(2),
    );
    mkdirSync(dirname(pluginDestination), { recursive: true, mode: 0o700 });
    cpSync(pluginRoot, pluginDestination, { recursive: true });

    this.#initializeRepository(this.#repository, false);
    this.#initialRepositoryDigest = digestTree(this.#repository);
    this.#initializeRepository(this.#pluginRepository, true);
    this.#currentSourceCommit = this.#git(this.#pluginRepository, [
      "rev-parse",
      "HEAD",
    ]).trim();

    this.#marketplacePath = join(
      this.#marketplaceRepository,
      ".agents/plugins/marketplace.json",
    );
    mkdirSync(dirname(this.#marketplacePath), {
      recursive: true,
      mode: 0o700,
    });
    this.#writeMarketplace(this.#currentSourceCommit);
    this.#initializeRepository(this.#marketplaceRepository, true);

    if (options.configuredMcp !== undefined) {
      const url =
        options.configuredMcp === "equivalent"
          ? "https://skillwire.dev/mcp"
          : "https://conflict.invalid/mcp";
      writeFileSync(
        join(this.#codexHome, "config.toml"),
        `[mcp_servers.skillwire]\nurl = "${url}"\n`,
        { mode: 0o600 },
      );
    }

    writeFileSync(this.#gitConfig, "", { mode: 0o600 });
    this.#gitConfigSet(
      `url.file://${this.#marketplaceRepository}/.insteadOf`,
      FIXTURE_MARKETPLACE_URL,
    );
    this.#gitConfigSet(
      `url.file://${this.#pluginRepository}/.insteadOf`,
      FIXTURE_PLUGIN_URL,
    );

    this.#managerPath = resolve(projectRoot, "node_modules/.bin/codex");
    this.#environment = {
      HOME: this.#home,
      CODEX_HOME: this.#codexHome,
      PATH: process.env["PATH"] ?? `${dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
      TERM: "dumb",
      GIT_CONFIG_GLOBAL: this.#gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "file:https",
      SKILLWIRE_EVAL_TOKEN: FIXTURE_CREDENTIAL,
    };
    const version = this.#run(["--version"]);
    const match = /codex-cli\s+([^\s]+)/.exec(version.stdout);
    if (match?.[1] === undefined) {
      throw new Error(
        `Unable to determine pinned Codex version: ${version.stdout}`,
      );
    }
    this.managerVersion = match[1];
    this.#initialMcpSnapshot = this.#mcpSnapshot();
  }

  addMarketplace(): void {
    this.#run([
      "plugin",
      "marketplace",
      "add",
      FIXTURE_MARKETPLACE_URL,
      "--ref",
      "main",
      "--json",
    ]);
  }

  listMarketplaces(): readonly NormalizedMarketplace[] {
    const result = this.#run(["plugin", "marketplace", "list", "--json"]);
    return extractArray(result.json).map((entry) => ({
      name: getString(entry, ["name", "marketplace_name", "marketplaceName"]),
    }));
  }

  listPlugins(
    options: { readonly available?: boolean } = {},
  ): readonly NormalizedPlugin[] {
    const args = ["plugin", "list", "--marketplace", "skillwire", "--json"];
    if (options.available === true) args.push("--available");
    const result = this.#run(args);
    const entries = extractPluginArray(result.json, options.available === true);
    if (entries.length === 0 && result.stdout.trim() !== "[]") {
      throw new Error(`Unrecognized plugin list: ${redact(result.stdout)}`);
    }
    return entries.map((entry) => {
      const installedValue = getUnknown(entry, [
        "installed",
        "is_installed",
        "isInstalled",
      ]);
      const version = getOptionalString(entry, [
        "version",
        "installed_version",
        "installedVersion",
      ]);
      return {
        name: getString(entry, ["name", "plugin_name", "pluginName"]),
        marketplaceName: getString(entry, [
          "marketplace_name",
          "marketplaceName",
          "marketplace",
        ]),
        installed:
          typeof installedValue === "boolean"
            ? installedValue
            : version !== undefined,
        ...(version === undefined ? {} : { version }),
      };
    });
  }

  installPlugin(): void {
    this.#run(["plugin", "add", PLUGIN_SELECTOR, "--json"]);
  }

  attemptInterruptedUpgrade(): boolean {
    const result = this.#run(
      ["plugin", "marketplace", "upgrade", "skillwire", "--json"],
      true,
      1,
    );
    return result.status === 0;
  }

  attemptInvalidUpgrade(): boolean {
    this.#writeMarketplace("f".repeat(40));
    this.#commit(this.#marketplaceRepository, "invalid upgrade fixture");
    const result = this.#run(
      ["plugin", "marketplace", "upgrade", "skillwire", "--json"],
      true,
    );
    this.#writeMarketplace(this.#currentSourceCommit);
    this.#commit(this.#marketplaceRepository, "restore valid fixture");
    return result.status === 0;
  }

  upgradePlugin(version: "0.1.1"): void {
    const manifestPath = join(
      this.#pluginRepository,
      CODEX_ADAPTER_SOURCE_PATH.slice(2),
      ".codex-plugin/plugin.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version: string;
    };
    manifest.version = version;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    validateCodexAdapterPackage(
      join(this.#pluginRepository, CODEX_ADAPTER_SOURCE_PATH.slice(2)),
    );
    this.#commit(this.#pluginRepository, `plugin ${version}`);
    this.#currentSourceCommit = this.#git(this.#pluginRepository, [
      "rev-parse",
      "HEAD",
    ]).trim();
    this.#writeMarketplace(this.#currentSourceCommit);
    this.#commit(this.#marketplaceRepository, `marketplace ${version}`);
    this.#run(["plugin", "marketplace", "upgrade", "skillwire", "--json"]);
  }

  installedVersion(): string | undefined {
    const roots = this.#installedPluginRoots();
    const root = roots.length === 1 ? roots[0] : undefined;
    if (root === undefined) return undefined;
    const manifest = JSON.parse(
      readFileSync(join(root, ".codex-plugin/plugin.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  }

  removePlugin(): void {
    this.#run(["plugin", "remove", PLUGIN_SELECTOR, "--json"]);
  }

  removeMarketplace(): void {
    this.#run(["plugin", "marketplace", "remove", "skillwire", "--json"]);
  }

  adapterOwnedFileCount(): number {
    return this.#installedPluginRoots().flatMap((root) => walkFiles(root))
      .length;
  }

  dependencyBehavior(state: DependencyScenario): DependencyBehavior {
    if (
      state === "equivalent-existing" &&
      this.#configuredMcp !== "equivalent"
    ) {
      throw new Error(
        "Equivalent-existing scenario requires matching MCP fixture",
      );
    }
    if (state === "name-conflict" && this.#configuredMcp !== "conflict") {
      throw new Error(
        "Name-conflict scenario requires conflicting MCP fixture",
      );
    }
    const noAttempt = state === "absent" || state === "name-conflict";
    return {
      state,
      effectiveBindingCount: this.effectiveInventory().mcpServers.filter(
        (name) => name === "skillwire",
      ).length,
      automaticAttempts: noAttempt ? 0 : 1,
      retries: 0,
      configurationOverwritten: false,
      ordinaryWorkContinues: true,
      explicitMcpPreserved:
        this.#configuredMcp === "equivalent" ||
        this.#configuredMcp === "conflict",
    };
  }

  configuredMcpIsUnchanged(): boolean {
    return this.#mcpSnapshot() === this.#initialMcpSnapshot;
  }

  effectiveInventory(): {
    readonly pluginSkills: readonly string[];
    readonly mcpServers: readonly string[];
    readonly installedPluginCount: number;
  } {
    const roots = this.#installedPluginRoots();
    const mcp = this.#run(["mcp", "list", "--json"]);
    const configuredServers = extractMcpNames(mcp.json);
    const declaredServers = roots.length === 0 ? [] : ["skillwire"];
    return {
      pluginSkills:
        roots.length === 0
          ? []
          : ["skillwire-autonomous-activation:autonomous-skill-activation"],
      mcpServers: [
        ...new Set([...configuredServers, ...declaredServers]),
      ].sort(),
      installedPluginCount: roots.length,
    };
  }

  installedPackageMatchesSource(): boolean {
    const roots = this.#installedPluginRoots();
    const installedRoot = roots.length === 1 ? roots[0] : undefined;
    if (installedRoot === undefined) return false;
    const sourcePackageReport = validateCodexAdapterPackage(
      join(this.#pluginRepository, CODEX_ADAPTER_SOURCE_PATH.slice(2)),
    );
    return (
      validateCodexAdapterPackage(installedRoot).packageSha256 ===
      sourcePackageReport.packageSha256
    );
  }

  profileContainsRemoteSkillContent(): boolean {
    return walkFiles(this.#codexHome).some((path) => {
      const bytes = readFileSync(path);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return false;
      }
      return /(?:revisionSha256\s*:|remote skill payload|resource body\s*:)/i.test(
        text,
      );
    });
  }

  outputsContainCredential(): boolean {
    return this.#outputs.some(({ stdout, stderr }) =>
      `${stdout}\n${stderr}`.includes(FIXTURE_CREDENTIAL),
    );
  }

  repositoryIsUnchanged(): boolean {
    return digestTree(this.#repository) === this.#initialRepositoryDigest;
  }

  profileModes(): { readonly home: number; readonly codexHome: number } {
    return {
      home: statSync(this.#home).mode & 0o777,
      codexHome: statSync(this.#codexHome).mode & 0o777,
    };
  }

  close(): void {
    rmSync(this.#root, { recursive: true, force: true });
  }

  #installedPluginRoots(): string[] {
    return walkFiles(this.#codexHome)
      .filter((path) => path.endsWith(`${sep}.codex-plugin${sep}plugin.json`))
      .filter((path) => {
        try {
          return (
            (JSON.parse(readFileSync(path, "utf8")) as { name?: string })
              .name === CODEX_ADAPTER_PLUGIN_NAME
          );
        } catch {
          return false;
        }
      })
      .map((path) => dirname(dirname(path)))
      .filter((path) =>
        CODEX_ADAPTER_FILES.every((relativePath) =>
          walkFiles(path).includes(join(path, ...relativePath.split("/"))),
        ),
      );
  }

  #writeMarketplace(sourceCommit: string): void {
    writeFileSync(
      this.#marketplacePath,
      `${JSON.stringify(
        {
          name: "skillwire",
          interface: { displayName: "SkillWire" },
          plugins: [
            {
              name: CODEX_ADAPTER_PLUGIN_NAME,
              source: {
                source: "git-subdir",
                url: FIXTURE_PLUGIN_URL,
                path: CODEX_ADAPTER_SOURCE_PATH,
                sha: sourceCommit,
              },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_USE",
              },
              category: "Developer Tools",
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  #commit(path: string, message: string): void {
    this.#git(path, ["add", "."]);
    this.#git(path, ["commit", "-m", message]);
  }

  #mcpSnapshot(): string {
    const result = this.#run(["mcp", "list", "--json"]);
    return JSON.stringify(extractMcpRecords(result.json));
  }

  #initializeRepository(path: string, commit: boolean): void {
    this.#git(path, ["init", "-b", "main"]);
    this.#git(path, ["config", "user.email", "fixture@skillwire.invalid"]);
    this.#git(path, ["config", "user.name", "SkillWire Fixture"]);
    if (commit) {
      this.#git(path, ["add", "."]);
      this.#git(path, ["commit", "-m", "fixture"]);
    }
  }

  #git(cwd: string, args: readonly string[]): string {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: this.#home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  #gitConfigSet(key: string, value: string): void {
    const result = spawnSync(
      "git",
      ["config", "--file", this.#gitConfig, key, value],
      {
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      },
    );
    if (result.status !== 0) {
      throw new Error(`git config failed: ${result.stderr}`);
    }
  }

  #run(
    args: readonly string[],
    allowFailure = false,
    timeoutMilliseconds = 30_000,
  ): CommandResult {
    const result = spawnSync(this.#managerPath, args, {
      cwd: this.#repository,
      encoding: "utf8",
      env: this.#environment,
      timeout: timeoutMilliseconds,
    });
    const stdout = result.stdout;
    const stderr = result.stderr;
    const parsedJson = parseJson(stdout);
    const commandResult: CommandResult = {
      status: result.status ?? 1,
      stdout,
      stderr,
      ...(parsedJson === undefined ? {} : { json: parsedJson }),
    };
    this.#outputs.push(commandResult);
    if (result.status !== 0 && !allowFailure) {
      throw new Error(
        `Codex manager failed (${args.join(" ")}): ${redact(stderr || stdout)}`,
      );
    }
    return commandResult;
  }
}

export function createCodexPluginManagerHarness(
  options: CodexPluginManagerHarnessOptions = {},
): CodexPluginManagerHarness {
  return new Harness(options);
}

function parseJson(value: string): unknown {
  if (value.trim() === "") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function extractArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ["marketplaces", "plugins", "items", "servers"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function extractPluginArray(
  value: unknown,
  includeAvailable: boolean,
): Record<string, unknown>[] {
  if (!isRecord(value)) return extractArray(value);
  const installed = value["installed"];
  const available = value["available"];
  if (Array.isArray(installed) || Array.isArray(available)) {
    return [
      ...(Array.isArray(installed) ? installed.filter(isRecord) : []),
      ...(includeAvailable && Array.isArray(available)
        ? available.filter(isRecord)
        : []),
    ];
  }
  return extractArray(value);
}

function extractMcpRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  const servers = value["servers"];
  if (Array.isArray(servers)) return servers.filter(isRecord);
  return Object.entries(value)
    .filter((entry): entry is [string, Record<string, unknown>] =>
      isRecord(entry[1]),
    )
    .map(([name, entry]) => ({ name, ...entry }));
}

function extractMcpNames(value: unknown): string[] {
  return extractMcpRecords(value)
    .map((entry) => getOptionalString(entry, ["name"]))
    .filter((name): name is string => name !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getUnknown(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const candidate = value[key];
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function getString(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string {
  const candidate = getOptionalString(value, keys);
  if (candidate === undefined) {
    throw new Error(`Expected manager field: ${keys.join("|")}`);
  }
  return candidate;
}

function getOptionalString(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  const candidate = getUnknown(value, keys);
  return typeof candidate === "string" ? candidate : undefined;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

function digestTree(root: string): string {
  const hash = createHash("sha256");
  for (const path of walkFiles(root).sort()) {
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function redact(value: string): string {
  return value.replaceAll(FIXTURE_CREDENTIAL, "[REDACTED]");
}
