import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface ApplicationConfig {
  readonly host: string;
  readonly unixSocketPath?: string | undefined;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly port: number;
  readonly databaseUrl: string;
  readonly apiKeyPepper: string;
  readonly catalogRoot?: string | undefined;
  readonly catalogRelease?: string | undefined;
  readonly catalogCacheMode?: "catalog-cold" | "catalog-warm" | undefined;
  readonly auditCleanupIntervalMilliseconds?: number | undefined;
  readonly shutdownGraceMilliseconds?: number | undefined;
  readonly logLevel?:
    | "trace"
    | "debug"
    | "info"
    | "warn"
    | "error"
    | "fatal"
    | "silent"
    | undefined;
  readonly maximumRequestBodyBytes?: number | undefined;
  readonly requestDeadlineMilliseconds?: number | undefined;
  readonly rateLimit?:
    | {
        readonly accountRequestsPerMinute: number;
        readonly apiKeyRequestsPerMinute: number;
        readonly burst: number;
      }
    | undefined;
  readonly githubIngestion?: GitHubIngestionConfig | undefined;
}

export interface GitHubIngestionConfig {
  readonly enabled: boolean;
  readonly token?: string | undefined;
  readonly schedulerIntervalMilliseconds: number;
  readonly discoveryCadenceMilliseconds: number;
  readonly sourceCadenceMilliseconds: number;
  readonly leaseDurationMilliseconds: number;
  readonly maximumSourcesPerTick: number;
  readonly maximumRequests: number;
  readonly maximumResponseBytes: number;
  readonly maximumResults: number;
  readonly maximumPagesPerQuery: number;
  readonly resultsPerPage: number;
  readonly discoveryQueries: readonly string[];
  readonly maximumQueries: number;
  readonly maximumTreeEntries: number;
  readonly maximumCandidates: number;
  readonly maximumResourcesPerSkill: number;
  readonly maximumDependenciesPerSkill: number;
  readonly maximumTextBytes: number;
  readonly maximumBundleBytes: number;
  readonly maximumRepositoryBytes: number;
  readonly requestTimeoutMilliseconds: number;
  readonly operationTimeoutMilliseconds: number;
  readonly maximumAttempts: number;
  readonly globalJobs: number;
}

const DEFAULT_PORT = 3000;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;
const MAX_SECRET_FILE_BYTES = 8192;

export function readRequiredConfiguration(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const directValue = environment[name];
  const fileName = `${name}_FILE`;
  const filePath = environment[fileName];
  if ((directValue === undefined) === (filePath === undefined)) {
    throw new Error(`Exactly one of ${name} or ${fileName} is required`);
  }
  if (directValue !== undefined) return directValue;
  if (filePath === undefined || !isAbsolute(filePath)) {
    throw new Error(`${fileName} must be an absolute path`);
  }
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${fileName} must identify a regular file`);
  }
  if (stats.size < 1 || stats.size > MAX_SECRET_FILE_BYTES) {
    throw new Error(`${fileName} has an invalid size`);
  }
  const bytes = readFileSync(filePath);
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${fileName} must contain UTF-8 text`);
  }
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(`${fileName} contains an invalid value`);
  }
  return value;
}

function readPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SKILLWIRE_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function readPositiveInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be a positive bounded integer`);
  }
  return parsed;
}

function readBoolean(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function readAllowedHosts(host: string, value: string | undefined): string[] {
  const configured = (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const hosts = configured.length > 0 ? configured : [...LOOPBACK_HOSTS];
  if (
    !LOOPBACK_HOSTS.includes(host as (typeof LOOPBACK_HOSTS)[number]) &&
    configured.length === 0
  ) {
    throw new Error(
      "SKILLWIRE_ALLOWED_HOSTS is required for non-loopback binds",
    );
  }
  if (
    hosts.length > 32 ||
    hosts.some(
      (entry) =>
        entry.length > 253 || !/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)$/.test(entry),
    )
  ) {
    throw new Error("SKILLWIRE_ALLOWED_HOSTS is invalid");
  }
  return [...new Set(hosts)];
}

function readDiscoveryQueries(value: string | undefined): readonly string[] {
  const defaults = [
    "filename:plugin.json path:.claude-plugin",
    "filename:SKILL.md",
  ];
  if (value === undefined) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(
      "SKILLWIRE_GITHUB_DISCOVERY_QUERIES must be a JSON string array",
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 16 ||
    parsed.some(
      (query) =>
        typeof query !== "string" ||
        query.length < 1 ||
        query.length > 256 ||
        hasAsciiControl(query),
    )
  ) {
    throw new Error("SKILLWIRE_GITHUB_DISCOVERY_QUERIES is invalid");
  }
  return [...new Set(parsed as string[])];
}

function readDatabaseUrl(value: string | undefined): string {
  if (value === undefined) throw new Error("DATABASE_URL is required");
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres or postgresql");
  }
  return value;
}

export function readDatabaseConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (
    environment["DATABASE_URL"] !== undefined ||
    environment["DATABASE_URL_FILE"] !== undefined
  ) {
    return readDatabaseUrl(
      readRequiredConfiguration(environment, "DATABASE_URL"),
    );
  }
  const password = readRequiredConfiguration(
    environment,
    "SKILLWIRE_DATABASE_PASSWORD",
  );
  const host = environment["SKILLWIRE_DATABASE_HOST"] ?? "postgres";
  const port = environment["SKILLWIRE_DATABASE_PORT"] ?? "5432";
  if (!/^[a-z0-9.-]+$/i.test(host) || !/^\d{1,5}$/.test(port)) {
    throw new Error("SkillWire database host or port is invalid");
  }
  return `postgresql://skillwire:${encodeURIComponent(password)}@${host}:${port}/skillwire`;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApplicationConfig {
  const apiKeyPepper = readRequiredConfiguration(
    environment,
    "SKILLWIRE_API_KEY_PEPPER",
  );
  if (Buffer.byteLength(apiKeyPepper) < 32) {
    throw new Error("SKILLWIRE_API_KEY_PEPPER must contain at least 32 bytes");
  }

  const host = environment["SKILLWIRE_BIND_HOST"] ?? "127.0.0.1";
  const unixSocketPath = environment["SKILLWIRE_UNIX_SOCKET_PATH"];
  if (
    unixSocketPath !== undefined &&
    (!isAbsolute(unixSocketPath) ||
      unixSocketPath.length > 103 ||
      !unixSocketPath.endsWith("/mcp.sock"))
  ) {
    throw new Error("SKILLWIRE_UNIX_SOCKET_PATH is invalid");
  }
  const catalogRoot = environment["SKILLWIRE_CATALOG_ROOT"] ?? process.cwd();
  if (!isAbsolute(catalogRoot)) {
    throw new Error("SKILLWIRE_CATALOG_ROOT must be an absolute path");
  }
  const catalogRelease =
    environment["SKILLWIRE_CATALOG_RELEASE"] ?? "launch-catalog-v1";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(catalogRelease)) {
    throw new Error("SKILLWIRE_CATALOG_RELEASE is invalid");
  }
  const catalogCacheMode =
    environment["SKILLWIRE_CATALOG_CACHE_MODE"] ?? "catalog-warm";
  if (
    catalogCacheMode !== "catalog-cold" &&
    catalogCacheMode !== "catalog-warm"
  ) {
    throw new Error("SKILLWIRE_CATALOG_CACHE_MODE is invalid");
  }
  const logLevel = environment["LOG_LEVEL"] ?? "info";
  if (
    !["trace", "debug", "info", "warn", "error", "fatal", "silent"].includes(
      logLevel,
    )
  ) {
    throw new Error("LOG_LEVEL is invalid");
  }
  const githubEnabled = readBoolean(
    "SKILLWIRE_GITHUB_INGESTION_ENABLED",
    environment["SKILLWIRE_GITHUB_INGESTION_ENABLED"],
  );
  const githubToken = githubEnabled
    ? readRequiredConfiguration(environment, "SKILLWIRE_GITHUB_TOKEN")
    : undefined;
  if (githubToken !== undefined && githubToken.length < 20) {
    throw new Error("SKILLWIRE_GITHUB_TOKEN is invalid");
  }
  const config: ApplicationConfig = {
    host,
    ...(unixSocketPath === undefined ? {} : { unixSocketPath }),
    allowedHosts: readAllowedHosts(
      host,
      environment["SKILLWIRE_ALLOWED_HOSTS"],
    ),
    port: readPort(environment["SKILLWIRE_PORT"]),
    databaseUrl: readDatabaseConfiguration(environment),
    apiKeyPepper,
    catalogRoot,
    catalogRelease,
    catalogCacheMode,
    auditCleanupIntervalMilliseconds:
      readPositiveInteger(
        "SKILLWIRE_AUDIT_CLEANUP_INTERVAL_SECONDS",
        environment["SKILLWIRE_AUDIT_CLEANUP_INTERVAL_SECONDS"],
        3600,
        86_400,
      ) * 1000,
    shutdownGraceMilliseconds: readPositiveInteger(
      "SKILLWIRE_SHUTDOWN_GRACE_MS",
      environment["SKILLWIRE_SHUTDOWN_GRACE_MS"],
      10_000,
      120_000,
    ),
    logLevel: logLevel as ApplicationConfig["logLevel"],
    maximumRequestBodyBytes: readPositiveInteger(
      "SKILLWIRE_MAX_REQUEST_BODY_BYTES",
      environment["SKILLWIRE_MAX_REQUEST_BODY_BYTES"],
      65_536,
      1_048_576,
    ),
    requestDeadlineMilliseconds: readPositiveInteger(
      "SKILLWIRE_REQUEST_DEADLINE_MS",
      environment["SKILLWIRE_REQUEST_DEADLINE_MS"],
      10_000,
      120_000,
    ),
    rateLimit: {
      accountRequestsPerMinute: readPositiveInteger(
        "SKILLWIRE_ACCOUNT_REQUESTS_PER_MINUTE",
        environment["SKILLWIRE_ACCOUNT_REQUESTS_PER_MINUTE"],
        120,
        100_000,
      ),
      apiKeyRequestsPerMinute: readPositiveInteger(
        "SKILLWIRE_API_KEY_REQUESTS_PER_MINUTE",
        environment["SKILLWIRE_API_KEY_REQUESTS_PER_MINUTE"],
        120,
        100_000,
      ),
      burst: readPositiveInteger(
        "SKILLWIRE_RATE_LIMIT_BURST",
        environment["SKILLWIRE_RATE_LIMIT_BURST"],
        30,
        10_000,
      ),
    },
    githubIngestion: {
      enabled: githubEnabled,
      ...(githubToken === undefined ? {} : { token: githubToken }),
      schedulerIntervalMilliseconds:
        readPositiveInteger(
          "SKILLWIRE_GITHUB_SCHEDULER_INTERVAL_SECONDS",
          environment["SKILLWIRE_GITHUB_SCHEDULER_INTERVAL_SECONDS"],
          60,
          3600,
        ) * 1000,
      discoveryCadenceMilliseconds:
        readPositiveInteger(
          "SKILLWIRE_GITHUB_DISCOVERY_CADENCE_SECONDS",
          environment["SKILLWIRE_GITHUB_DISCOVERY_CADENCE_SECONDS"],
          3600,
          604_800,
        ) * 1000,
      sourceCadenceMilliseconds:
        readPositiveInteger(
          "SKILLWIRE_GITHUB_SYNC_CADENCE_SECONDS",
          environment["SKILLWIRE_GITHUB_SYNC_CADENCE_SECONDS"],
          3600,
          604_800,
        ) * 1000,
      leaseDurationMilliseconds:
        readPositiveInteger(
          "SKILLWIRE_GITHUB_LEASE_SECONDS",
          environment["SKILLWIRE_GITHUB_LEASE_SECONDS"],
          60,
          3600,
        ) * 1000,
      maximumSourcesPerTick: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_SOURCES_PER_TICK",
        environment["SKILLWIRE_GITHUB_MAX_SOURCES_PER_TICK"],
        10,
        100,
      ),
      maximumRequests: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_REQUESTS_PER_RUN",
        environment["SKILLWIRE_GITHUB_MAX_REQUESTS_PER_RUN"] ??
          environment["SKILLWIRE_GITHUB_MAX_REQUESTS"],
        1000,
        2000,
      ),
      maximumResponseBytes: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_RESPONSE_BYTES",
        environment["SKILLWIRE_GITHUB_MAX_RESPONSE_BYTES"],
        8 * 1024 * 1024,
        32 * 1024 * 1024,
      ),
      maximumResults: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_RESULTS_PER_RUN",
        environment["SKILLWIRE_GITHUB_MAX_RESULTS_PER_RUN"] ??
          environment["SKILLWIRE_GITHUB_MAX_RESULTS"],
        1000,
        4000,
      ),
      maximumPagesPerQuery: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_PAGES_PER_QUERY",
        environment["SKILLWIRE_GITHUB_MAX_PAGES_PER_QUERY"],
        5,
        10,
      ),
      resultsPerPage: readPositiveInteger(
        "SKILLWIRE_GITHUB_RESULTS_PER_PAGE",
        environment["SKILLWIRE_GITHUB_RESULTS_PER_PAGE"],
        100,
        100,
      ),
      discoveryQueries: readDiscoveryQueries(
        environment["SKILLWIRE_GITHUB_DISCOVERY_QUERIES"],
      ),
      maximumQueries: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_QUERIES",
        environment["SKILLWIRE_GITHUB_MAX_QUERIES"],
        8,
        16,
      ),
      maximumTreeEntries: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_TREE_ENTRIES",
        environment["SKILLWIRE_GITHUB_MAX_TREE_ENTRIES"],
        20_000,
        50_000,
      ),
      maximumCandidates: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_CANDIDATES",
        environment["SKILLWIRE_GITHUB_MAX_CANDIDATES"],
        256,
        256,
      ),
      maximumResourcesPerSkill: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_RESOURCES_PER_SKILL",
        environment["SKILLWIRE_GITHUB_MAX_RESOURCES_PER_SKILL"],
        64,
        64,
      ),
      maximumDependenciesPerSkill: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_DEPENDENCIES_PER_SKILL",
        environment["SKILLWIRE_GITHUB_MAX_DEPENDENCIES_PER_SKILL"],
        32,
        32,
      ),
      maximumTextBytes: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_TEXT_BYTES",
        environment["SKILLWIRE_GITHUB_MAX_TEXT_BYTES"],
        256 * 1024,
        256 * 1024,
      ),
      maximumBundleBytes: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_BUNDLE_BYTES",
        environment["SKILLWIRE_GITHUB_MAX_BUNDLE_BYTES"],
        2 * 1024 * 1024,
        2 * 1024 * 1024,
      ),
      maximumRepositoryBytes: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_REPOSITORY_BYTES",
        environment["SKILLWIRE_GITHUB_MAX_REPOSITORY_BYTES"],
        32 * 1024 * 1024,
        64 * 1024 * 1024,
      ),
      requestTimeoutMilliseconds: readPositiveInteger(
        "SKILLWIRE_GITHUB_REQUEST_TIMEOUT_MS",
        environment["SKILLWIRE_GITHUB_REQUEST_TIMEOUT_MS"],
        30_000,
        120_000,
      ),
      operationTimeoutMilliseconds: readPositiveInteger(
        "SKILLWIRE_GITHUB_OPERATION_TIMEOUT_MS",
        environment["SKILLWIRE_GITHUB_OPERATION_TIMEOUT_MS"],
        300_000,
        900_000,
      ),
      maximumAttempts: readPositiveInteger(
        "SKILLWIRE_GITHUB_MAX_ATTEMPTS",
        environment["SKILLWIRE_GITHUB_MAX_ATTEMPTS"],
        3,
        4,
      ),
      globalJobs: readPositiveInteger(
        "SKILLWIRE_GITHUB_GLOBAL_JOBS",
        environment["SKILLWIRE_GITHUB_GLOBAL_JOBS"],
        2,
        4,
      ),
    },
  };
  const github = config.githubIngestion;
  if (
    github !== undefined &&
    (github.requestTimeoutMilliseconds >= github.operationTimeoutMilliseconds ||
      github.discoveryQueries.length > github.maximumQueries ||
      github.maximumResults >
        github.maximumPagesPerQuery *
          github.resultsPerPage *
          github.maximumQueries)
  ) {
    throw new Error("GitHub ingestion budgets are inconsistent");
  }
  return config;
}
