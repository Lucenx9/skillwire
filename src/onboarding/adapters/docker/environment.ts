import { isAbsolute } from "node:path";

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
