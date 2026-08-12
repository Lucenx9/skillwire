import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadActivationEvidence,
  validateActivationEvidence,
} from "../../../src/evaluation/activation-evidence.js";

const projectRoot = process.cwd();
const CORPUS_SHA256 =
  "a06e1ced82026bf007e0f1d9ee53c0a57c526cf59784285098a2840cb13e8b28";
const SERVER_ONLY_EVIDENCE_SHA256 =
  "04cd236d6ddd27f30c21f7d332577ef3a91a3f55fc6ab79d1fd1f02d4900db2d";

function sha256(relativePath: string): string {
  return createHash("sha256")
    .update(readFileSync(join(projectRoot, relativePath)))
    .digest("hex");
}

describe("immutable autonomous-activation baseline", () => {
  it("keeps the 75-case corpus and historical server-only evidence byte-stable", () => {
    expect(sha256("evaluation/autonomous-activation.v1.json")).toBe(
      CORPUS_SHA256,
    );
    expect(sha256("evaluation/evidence/003/candidate-v1.json")).toBe(
      SERVER_ONLY_EVIDENCE_SHA256,
    );
  });

  it("preserves the validated 0/7 server-only result as negative evidence", () => {
    const evidencePath = join(
      projectRoot,
      "evaluation/evidence/003/candidate-v1.json",
    );
    const evidence = loadActivationEvidence(evidencePath) as {
      harness: { name: string; version: string };
      observations: { toolCalls: unknown[] }[];
    };
    const report = validateActivationEvidence(evidence, projectRoot);

    expect(evidence.harness).toEqual({ name: "Codex CLI", version: "0.147.0" });
    expect(evidence.observations).toHaveLength(8);
    expect(
      evidence.observations
        .slice(0, 7)
        .every(({ toolCalls }) => toolCalls.length === 0),
    ).toBe(true);
    expect(report.status).toBe("incomplete");
    expect(report.metrics.spontaneousActivation).toEqual({
      numerator: 0,
      denominator: 7,
      rate: 0,
    });
    expect(report.diagnosticCodes).toContain("EXPECTED_SEARCH_MISSING");
    expect(report.diagnosticCodes).toContain("INCOMPLETE_TRACE");
  });
});
