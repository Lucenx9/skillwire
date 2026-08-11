import { z } from "zod";

import { canonicalJson, sha256Hex } from "./canonical-revision.js";
import type {
  CurrentAdvisoryStatus,
  RevisionAdvisory,
  VerifiedAdvisoryChain,
} from "./types.js";

export const EMPTY_ADVISORY_CHAIN_HEAD = "0".repeat(64);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const advisorySchema = z
  .object({
    sequence: z.number().int().min(1),
    previousEventHash: sha256Schema,
    advisoryId: z.string().min(1).max(120),
    skillId: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    revision: z
      .string()
      .regex(/^(?!latest$|main$|master$|HEAD$)[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .max(128),
    revisionSha256: sha256Schema,
    kind: z.enum(["security", "availability"]),
    state: z.enum(["revoked", "unavailable", "available"]),
    reasonCode: z
      .string()
      .regex(/^[A-Z0-9_]+$/)
      .max(120),
    effectiveAt: z.iso.datetime(),
    eventHash: sha256Schema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.kind === "security" && event.state !== "revoked") {
      context.addIssue({
        code: "custom",
        message: "Security advisories must revoke the revision",
      });
    }
    if (event.kind === "availability" && event.state === "revoked") {
      context.addIssue({
        code: "custom",
        message: "Availability advisories cannot revoke the revision",
      });
    }
  });

function revisionKey(skillId: string, revision: string): string {
  return `${skillId}\0${revision}`;
}

export function advisoryEventPreimage(
  event: Omit<RevisionAdvisory, "eventHash">,
): string {
  return canonicalJson(event);
}

export function advisoryEventHash(
  event: Omit<RevisionAdvisory, "eventHash">,
): string {
  return sha256Hex(advisoryEventPreimage(event));
}

export function createAdvisoryEvent(
  event: Omit<RevisionAdvisory, "eventHash">,
): RevisionAdvisory {
  return { ...event, eventHash: advisoryEventHash(event) };
}

export function serializeAdvisoryChain(
  events: readonly RevisionAdvisory[],
): string {
  return events.length === 0
    ? ""
    : `${events.map((event) => canonicalJson(event)).join("\n")}\n`;
}

export function parseAdvisoryChain(serialized: string): RevisionAdvisory[] {
  if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) {
    throw new Error("Advisory chain exceeds the size limit");
  }
  if (serialized.length === 0) return [];
  if (!serialized.endsWith("\n")) {
    throw new Error("Advisory chain must end with a newline");
  }
  const lines = serialized.slice(0, -1).split("\n");
  return lines.map((line) => {
    if (line.length === 0) throw new Error("Advisory chain has an empty event");
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error("Advisory event is not valid JSON");
    }
    const parsed = advisorySchema.safeParse(value);
    if (!parsed.success) throw new Error("Advisory event is invalid");
    if (canonicalJson(parsed.data) !== line) {
      throw new Error("Advisory event is not canonically serialized");
    }
    return parsed.data;
  });
}

export function verifyAdvisoryChain(
  events: readonly RevisionAdvisory[],
  revisionHashes: ReadonlyMap<string, string>,
  expectedHead?: string,
): VerifiedAdvisoryChain {
  const statusByRevision = new Map<string, CurrentAdvisoryStatus>();
  let previousEventHash = EMPTY_ADVISORY_CHAIN_HEAD;

  events.forEach((event, index) => {
    const parsed = advisorySchema.safeParse(event);
    if (!parsed.success) throw new Error("Advisory event is invalid");
    if (event.sequence !== index + 1) {
      throw new Error("Advisory sequences must be contiguous and monotonic");
    }
    if (event.previousEventHash !== previousEventHash) {
      throw new Error("Advisory previous-event hash is invalid");
    }
    const { eventHash, ...preimage } = event;
    if (eventHash !== advisoryEventHash(preimage)) {
      throw new Error("Advisory event hash is invalid");
    }
    const key = revisionKey(event.skillId, event.revision);
    if (revisionHashes.get(key) !== event.revisionSha256) {
      throw new Error("Advisory revision binding is invalid");
    }
    const current = statusByRevision.get(key) ?? "available";
    if (current === "revoked" && event.state !== "revoked") {
      throw new Error("Security revocation is terminal");
    }
    statusByRevision.set(key, event.state);
    previousEventHash = event.eventHash;
  });

  if (expectedHead !== undefined && expectedHead !== previousEventHash) {
    throw new Error("Advisory chain head does not match the release");
  }
  return Object.freeze({
    events: Object.freeze(events.map((event) => Object.freeze({ ...event }))),
    head: previousEventHash,
    statusByRevision,
  });
}

export function advisoryStatusFor(
  chain: VerifiedAdvisoryChain,
  skillId: string,
  revision: string,
): CurrentAdvisoryStatus {
  return (
    chain.statusByRevision.get(revisionKey(skillId, revision)) ?? "available"
  );
}
