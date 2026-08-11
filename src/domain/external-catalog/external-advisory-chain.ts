import { canonicalJson, sha256Hex } from "../catalog/canonical-revision.js";

export interface ExternalAdvisoryChainEvent {
  readonly sequence: string;
  readonly previousEventSha256: string;
  readonly revisionId: string;
  readonly kind: "availability" | "security";
  readonly status: "available" | "unavailable" | "revoked";
  readonly reasonCode: string;
  readonly effectiveAt: string;
  readonly eventSha256: string;
}

export type ExternalAdvisoryEventInput = Omit<
  ExternalAdvisoryChainEvent,
  "eventSha256"
>;

export function hashExternalAdvisoryEvent(
  event: ExternalAdvisoryEventInput,
): string {
  return sha256Hex(canonicalJson(event));
}

export function verifyExternalAdvisoryChain(
  events: readonly ExternalAdvisoryChainEvent[],
  expectedHead: string,
): void {
  let sequence = 0n;
  let previous = "0".repeat(64);
  for (const event of events) {
    sequence += 1n;
    if (
      event.sequence !== sequence.toString() ||
      event.previousEventSha256 !== previous ||
      hashExternalAdvisoryEvent({
        sequence: event.sequence,
        previousEventSha256: event.previousEventSha256,
        revisionId: event.revisionId,
        kind: event.kind,
        status: event.status,
        reasonCode: event.reasonCode,
        effectiveAt: event.effectiveAt,
      }) !== event.eventSha256
    ) {
      throw new Error("ADVISORY_CHAIN_INVALID");
    }
    previous = event.eventSha256;
  }
  if (previous !== expectedHead) throw new Error("ADVISORY_CHAIN_INVALID");
}
