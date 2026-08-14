import { createHash } from "node:crypto";

import { redactOutput, type ExitClass } from "./output.js";

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Preview contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported preview value");
}

export interface CanonicalPreview {
  readonly command: string;
  readonly json: string;
  readonly hash: string;
}

export function canonicalPreview(
  command: string,
  scope: unknown,
): CanonicalPreview {
  const json = canonical({ command, scope: redactOutput(scope) });
  return {
    command,
    json,
    hash: createHash("sha256").update(json).digest("hex"),
  };
}

export function confirmPreview(
  preview: CanonicalPreview,
  confirmation: string | undefined,
): true {
  if (
    confirmation === undefined ||
    !/^[0-9a-f]{64}$/.test(confirmation) ||
    confirmation !== preview.hash
  ) {
    throw new Error("Exact preview hash confirmation is required");
  }
  return true;
}

const exitCodes: Readonly<Record<ExitClass, number>> = {
  success: 0,
  "internal-failure": 1,
  "invalid-invocation": 2,
  "unsupported-prerequisite": 3,
  "policy-or-ownership-conflict": 4,
  "degraded-or-incomplete": 5,
  "service-failure": 6,
  "credential-or-authentication-failure": 7,
  "client-contract-failure": 8,
  "schema-incompatibility": 9,
  "rollback-required": 10,
  "user-cancellation": 11,
  "release-integrity-failure": 12,
};

export function exitCodeForClass(exitClass: ExitClass): number {
  return exitCodes[exitClass];
}
