import { describe, expect, it } from "vitest";

import {
  hashExternalAdvisoryEvent,
  verifyExternalAdvisoryChain,
  type ExternalAdvisoryChainEvent,
} from "../../../src/domain/external-catalog/external-advisory-chain.js";

describe("external advisory chain", () => {
  it("binds monotonic order, previous hashes, and event content", () => {
    const firstInput = {
      sequence: "1",
      previousEventSha256: "0".repeat(64),
      revisionId: "revision-1",
      kind: "availability" as const,
      status: "unavailable" as const,
      reasonCode: "UPSTREAM_SKILL_REMOVED",
      effectiveAt: "2026-08-11T00:00:00.000Z",
    };
    const first: ExternalAdvisoryChainEvent = {
      ...firstInput,
      eventSha256: hashExternalAdvisoryEvent(firstInput),
    };
    expect(() => {
      verifyExternalAdvisoryChain([first], first.eventSha256);
    }).not.toThrow();
    expect(() => {
      verifyExternalAdvisoryChain(
        [{ ...first, reasonCode: "MUTATED" }],
        first.eventSha256,
      );
    }).toThrow("ADVISORY_CHAIN_INVALID");
    expect(() => {
      verifyExternalAdvisoryChain([], first.eventSha256);
    }).toThrow("ADVISORY_CHAIN_INVALID");
  });
});
