import type {
  CandidateClassification,
  ClassificationActor,
  ExternalValidationFinding,
} from "./types.js";

const legalTransitions = new Set([
  "absent:discovered:discovery",
  "absent:discovered:synchronization",
  "discovered:verified:verifier",
  "discovered:quarantined:verifier",
  "verified:quarantined:administrator",
  "curated:quarantined:administrator",
  "quarantined:verified:verifier",
  "verified:curated:administrator",
]);

export function applyCandidateTransition(
  current: CandidateClassification | undefined,
  next: CandidateClassification,
  actor: ClassificationActor,
): CandidateClassification {
  if (current === next) return current;
  const key = `${current ?? "absent"}:${next}:${actor}`;
  if (!legalTransitions.has(key)) {
    throw new Error("CLASSIFICATION_TRANSITION_INVALID");
  }
  return next;
}

export function stableFindings(
  findings: readonly ExternalValidationFinding[],
): readonly ExternalValidationFinding[] {
  const unique = new Map<string, ExternalValidationFinding>();
  for (const finding of findings) {
    const key = [
      finding.code,
      finding.severity,
      finding.subjectKind,
      finding.subjectId,
    ].join(":");
    unique.set(key, finding);
  }
  return [...unique.values()].toSorted((left, right) => {
    const leftKey = `${left.code}:${left.subjectKind}:${left.subjectId}:${left.severity}`;
    const rightKey = `${right.code}:${right.subjectKind}:${right.subjectId}:${right.severity}`;
    return leftKey.localeCompare(rightKey, "en-US");
  });
}
