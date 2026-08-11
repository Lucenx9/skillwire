import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface ApplicationConfig {
  readonly host: string;
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

function readDatabaseUrl(value: string | undefined): string {
  if (value === undefined) throw new Error("DATABASE_URL is required");
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres or postgresql");
  }
  return value;
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
  return {
    host,
    allowedHosts: readAllowedHosts(
      host,
      environment["SKILLWIRE_ALLOWED_HOSTS"],
    ),
    port: readPort(environment["SKILLWIRE_PORT"]),
    databaseUrl: readDatabaseUrl(
      readRequiredConfiguration(environment, "DATABASE_URL"),
    ),
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
  };
}
