import { describe, expect, it } from "vitest";

import {
  advisoryStatusFor,
  createAdvisoryEvent,
  EMPTY_ADVISORY_CHAIN_HEAD,
  parseAdvisoryChain,
  serializeAdvisoryChain,
  verifyAdvisoryChain,
} from "../../../src/domain/catalog/advisory-chain.js";
import type { RevisionAdvisory } from "../../../src/domain/catalog/types.js";

const skillId = "typescript-code-review";
const revision = "1.0.0";
const revisionSha256 = "a".repeat(64);
const hashes = new Map([[`${skillId}\0${revision}`, revisionSha256]]);

function chain(): RevisionAdvisory[] {
  const first = createAdvisoryEvent({
    sequence: 1,
    previousEventHash: EMPTY_ADVISORY_CHAIN_HEAD,
    advisoryId: "source-unavailable",
    skillId,
    revision,
    revisionSha256,
    kind: "availability",
    state: "unavailable",
    reasonCode: "SOURCE_UNAVAILABLE",
    effectiveAt: "2026-08-11T01:00:00.000Z",
  });
  const second = createAdvisoryEvent({
    sequence: 2,
    previousEventHash: first.eventHash,
    advisoryId: "source-restored",
    skillId,
    revision,
    revisionSha256,
    kind: "availability",
    state: "available",
    reasonCode: "SOURCE_RESTORED",
    effectiveAt: "2026-08-11T02:00:00.000Z",
  });
  const third = createAdvisoryEvent({
    sequence: 3,
    previousEventHash: second.eventHash,
    advisoryId: "security-revoked",
    skillId,
    revision,
    revisionSha256,
    kind: "security",
    state: "revoked",
    reasonCode: "SECURITY_REVOKED",
    effectiveAt: "2026-08-11T03:00:00.000Z",
  });
  return [first, second, third];
}

function eventAt(
  events: readonly RevisionAdvisory[],
  index: number,
): RevisionAdvisory {
  const event = events[index];
  if (event === undefined) throw new Error("Expected advisory event");
  return event;
}

describe("advisory hash chain", () => {
  it("round-trips canonical JSONL and folds terminal revocation", () => {
    const events = chain();
    const serialized = serializeAdvisoryChain(events);
    const verified = verifyAdvisoryChain(
      parseAdvisoryChain(serialized),
      hashes,
      events[2]?.eventHash,
    );

    expect(verified.head).toBe(events[2]?.eventHash);
    expect(advisoryStatusFor(verified, skillId, revision)).toBe("revoked");
  });

  it.each([
    [
      "mutation",
      (events: RevisionAdvisory[]) => {
        events[0] = { ...eventAt(events, 0), reasonCode: "MUTATED" };
      },
    ],
    [
      "deletion",
      (events: RevisionAdvisory[]) => {
        events.splice(1, 1);
      },
    ],
    [
      "insertion",
      (events: RevisionAdvisory[]) => {
        events.splice(1, 0, { ...eventAt(events, 0) });
      },
    ],
    [
      "reordering",
      (events: RevisionAdvisory[]) => {
        const first = eventAt(events, 0);
        const second = eventAt(events, 1);
        [events[0], events[1]] = [second, first];
      },
    ],
    [
      "broken link",
      (events: RevisionAdvisory[]) => {
        events[1] = {
          ...eventAt(events, 1),
          previousEventHash: "b".repeat(64),
        };
      },
    ],
    [
      "wrong revision binding",
      (events: RevisionAdvisory[]) => {
        events[0] = {
          ...eventAt(events, 0),
          revisionSha256: "b".repeat(64),
        };
      },
    ],
  ] as const)("rejects %s", (_, mutate) => {
    const events = chain();
    mutate(events);
    expect(() => verifyAdvisoryChain(events, hashes)).toThrow();
  });

  it("rejects a release head mismatch and restoration after revocation", () => {
    const events = chain();
    expect(() => verifyAdvisoryChain(events, hashes, "f".repeat(64))).toThrow();

    const restored = createAdvisoryEvent({
      sequence: 4,
      previousEventHash: eventAt(events, 2).eventHash,
      advisoryId: "invalid-restore",
      skillId,
      revision,
      revisionSha256,
      kind: "availability",
      state: "available",
      reasonCode: "SOURCE_RESTORED",
      effectiveAt: "2026-08-11T04:00:00.000Z",
    });
    expect(() => verifyAdvisoryChain([...events, restored], hashes)).toThrow();
  });
});
