export interface ApplicationConfig {
  readonly host: string;
  readonly port: number;
  readonly bearerToken: string;
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

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApplicationConfig {
  const bearerToken = environment["SKILLWIRE_API_KEY"];
  if (bearerToken === undefined || bearerToken.length < 24) {
    throw new Error("SKILLWIRE_API_KEY must contain at least 24 characters");
  }

  return {
    host: environment["SKILLWIRE_HOST"] ?? "127.0.0.1",
    port: readPort(environment["SKILLWIRE_PORT"]),
    bearerToken,
  };
}
