export interface ApplicationConfig {
  readonly host: string;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly port: number;
  readonly databaseUrl: string;
  readonly apiKeyPepper: string;
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
  const apiKeyPepper = environment["SKILLWIRE_API_KEY_PEPPER"];
  if (apiKeyPepper === undefined || Buffer.byteLength(apiKeyPepper) < 32) {
    throw new Error("SKILLWIRE_API_KEY_PEPPER must contain at least 32 bytes");
  }

  const host = environment["SKILLWIRE_HOST"] ?? "127.0.0.1";
  return {
    host,
    allowedHosts: readAllowedHosts(
      host,
      environment["SKILLWIRE_ALLOWED_HOSTS"],
    ),
    port: readPort(environment["SKILLWIRE_PORT"]),
    databaseUrl: readDatabaseUrl(environment["DATABASE_URL"]),
    apiKeyPepper,
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
