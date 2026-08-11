export interface ApplicationConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly apiKeyPepper: string;
}

const DEFAULT_PORT = 3000;

function readPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SKILLWIRE_PORT must be an integer from 1 to 65535");
  }
  return port;
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

  return {
    host: environment["SKILLWIRE_HOST"] ?? "127.0.0.1",
    port: readPort(environment["SKILLWIRE_PORT"]),
    databaseUrl: readDatabaseUrl(environment["DATABASE_URL"]),
    apiKeyPepper,
  };
}
