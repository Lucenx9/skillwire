import { describe, expect, it } from "vitest";

import {
  applyCandidateTransition,
  stableFindings,
} from "../../../src/domain/external-catalog/candidate-policy.js";

describe("external candidate policy", () => {
  it("allows only legal deterministic transitions and never automates curation", () => {
    expect(applyCandidateTransition(undefined, "discovered", "discovery")).toBe(
      "discovered",
    );
    expect(applyCandidateTransition("discovered", "verified", "verifier")).toBe(
      "verified",
    );
    expect(
      applyCandidateTransition("verified", "curated", "administrator"),
    ).toBe("curated");
    expect(() =>
      applyCandidateTransition("verified", "curated", "verifier"),
    ).toThrow("CLASSIFICATION_TRANSITION_INVALID");
    expect(() =>
      applyCandidateTransition("quarantined", "curated", "administrator"),
    ).toThrow("CLASSIFICATION_TRANSITION_INVALID");
  });

  it("sorts and deduplicates stable non-content findings", () => {
    expect(
      stableFindings([
        {
          code: "LICENSE_MISSING",
          severity: "error",
          subjectKind: "candidate",
          subjectId: "b",
        },
        {
          code: "PATH_UNSAFE",
          severity: "error",
          subjectKind: "resource",
          subjectId: "a",
        },
        {
          code: "LICENSE_MISSING",
          severity: "error",
          subjectKind: "candidate",
          subjectId: "b",
        },
      ]).map(({ code, subjectId }) => `${code}:${subjectId}`),
    ).toEqual(["LICENSE_MISSING:b", "PATH_UNSAFE:a"]);
  });
});
