import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadActivationEvidence,
  validateActivationEvidence,
  validatePairedActivationEvidence,
} from "../../../src/evaluation/activation-evidence.js";
import { validateActivationReleaseSubset } from "../../../src/evaluation/activation-release-subset.js";
import {
  loadActivationFixtures,
  validateActivationFixtures,
} from "../../../src/evaluation/activation-corpus-runner.js";

const projectRoot = process.cwd();
const CORPUS_SHA256 =
  "a06e1ced82026bf007e0f1d9ee53c0a57c526cf59784285098a2840cb13e8b28";
const SERVER_ONLY_EVIDENCE_SHA256 =
  "04cd236d6ddd27f30c21f7d332577ef3a91a3f55fc6ab79d1fd1f02d4900db2d";
const RELEASE_SUBSET_SHA256 =
  "d88eb75cef1a426d05094b49bf0a64700ff0a7eebb023747349dd48dd4cd4b74";
const PAIRED_EVIDENCE_SHA256 =
  "0e7c1aec0339292b17c81ad9f725ffc22932bfa5030b5715a7f7fc1750aa28e6";
const LOCAL_OVERLAP_EVIDENCE_SHA256 =
  "213e2ea57c4f8e5f1d836567ebddffe100ad5ec72a3dd4e59dfe6a3abba410e8";

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

  it("freezes the outcome-independent 8/3/2/2 release-candidate pilot", () => {
    expect(
      sha256("evaluation/autonomous-activation-release-subset.v1.json"),
    ).toBe(RELEASE_SUBSET_SHA256);
    const fixtures = validateActivationFixtures(
      loadActivationFixtures(projectRoot),
    );
    const subset = validateActivationReleaseSubset(
      projectRoot,
      fixtures.corpus,
    );

    expect(subset.caseIds).toHaveLength(15);
    expect(subset.strata.cleanAutomatic).toHaveLength(8);
    expect(subset.strata.irrelevant).toHaveLength(3);
    expect(subset.strata.userRequestedExplicit).toHaveLength(2);
    expect(subset.strata.userRequestedWithoutIntent).toHaveLength(2);
  });

  it("preserves the separately observed local-overlap conditions", () => {
    expect(sha256("evaluation/evidence/003/local-overlap-v1.json")).toBe(
      LOCAL_OVERLAP_EVIDENCE_SHA256,
    );
    const evidence = JSON.parse(
      readFileSync(
        join(projectRoot, "evaluation/evidence/003/local-overlap-v1.json"),
        "utf8",
      ),
    ) as {
      conditions: {
        condition: string;
        observations: {
          caseId: string;
          skillWireOperations: unknown[];
          clientTreeWrites: number;
          localInventoryWrites: number;
        }[];
        metrics: {
          completed: number;
          remoteOverrideViolations: number;
        };
      }[];
    };

    expect(evidence.conditions.map(({ condition }) => condition)).toEqual([
      "server-only",
      "server-plus-adapter",
    ]);
    for (const condition of evidence.conditions) {
      expect(condition.observations.map(({ caseId }) => caseId)).toEqual([
        "auto-overlap-1",
        "auto-overlap-2",
        "auto-overlap-3",
        "auto-overlap-4",
        "auto-overlap-5",
      ]);
      expect(condition.metrics).toMatchObject({
        completed: 5,
        remoteOverrideViolations: 0,
      });
      expect(
        condition.observations.every(
          ({ skillWireOperations, clientTreeWrites, localInventoryWrites }) =>
            skillWireOperations.length === 0 &&
            clientTreeWrites === 0 &&
            localInventoryWrites === 0,
        ),
      ).toBe(true);
    }
  });

  it("validates the immutable paired evidence against its exact historical source", () => {
    const evidencePath = "evaluation/evidence/003/adapter-pair-v1.json";
    expect(sha256(evidencePath)).toBe(PAIRED_EVIDENCE_SHA256);
    const evidence = JSON.parse(
      readFileSync(join(projectRoot, evidencePath), "utf8"),
    ) as {
      experiment: { skillWireCommit: string };
      adapter: { sourceCommit: string; packageSha256: string };
      claimEligibility: { eligible: boolean };
    };
    expect(
      validatePairedActivationEvidence(evidence, projectRoot),
    ).toMatchObject({
      status: "incomplete",
      claimEligibility: { eligible: false },
    });
    expect(evidence.experiment.skillWireCommit).toBe(
      "bd7de55fefc602a7ad8fdaf1683f6dbb9eab07f9",
    );
    expect(evidence.adapter.sourceCommit).toBe(
      "bd7de55fefc602a7ad8fdaf1683f6dbb9eab07f9",
    );
    expect(evidence.adapter.packageSha256).toBe(
      "7939fa2ca5db807365a9f54c90534538291c09bbfae56762e72f372447998830",
    );
    expect(evidence.claimEligibility.eligible).toBe(false);
  });
});
