const FORBIDDEN_KEY =
  /authorization|credential|token|secret|digest|pepper|repository|query|task|content|body|path|sql|source|instruction|resource/i;
const BEARER_VALUE = /\bbearer\s+\S+/i;
const API_KEY_VALUE = /\bskillwire_[A-Za-z0-9_-]+\b/;
const REPOSITORY_HASH_VALUE = /\b[0-9a-f]{64}\b/;
const LOCAL_PATH_VALUE = /(?:^|\s)(?:\/home\/|\/Users\/|[A-Za-z]:\\)/;

export const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  return BEARER_VALUE.test(value) ||
    API_KEY_VALUE.test(value) ||
    REPOSITORY_HASH_VALUE.test(value) ||
    LOCAL_PATH_VALUE.test(value)
    ? REDACTED
    : value;
}

export function redactSensitive(value: unknown, key = ""): unknown {
  if (FORBIDDEN_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSensitive(entryValue, entryKey),
      ]),
    );
  }
  return value;
}
