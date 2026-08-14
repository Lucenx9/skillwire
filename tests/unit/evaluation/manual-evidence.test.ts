import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  derivePairedClaimEligibility,
  EvidenceValidationError,
  loadActivationEvidence,
  recomputeActivationEvidenceMetrics,
  validateActivationEvidence,
  validatePairedActivationEvidence,
} from "../../../src/evaluation/activation-evidence.js";
import { createPairedActivationEvidenceFixture } from "../../helpers/paired-activation-evidence.js";
import {
  loadActivationFixtures,
  validateActivationFixtures,
} from "../../../src/evaluation/activation-corpus-runner.js";

const projectRoot = process.cwd();
const fixture = (name: string) =>
  join(projectRoot, "tests", "fixtures", "activation", name);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const emptyInventorySchema = z
  .object({
    platformBaselineSkills: z.array(z.string()),
    userSkills: z.array(z.string()).max(0),
    repositorySkills: z.array(z.string()).max(0),
    adminSkills: z.array(z.string()).max(0),
    pluginSkills: z.array(z.string()),
    mcpServers: z.tuple([z.literal("skillwire")]),
    inventorySha256: sha256Schema,
  })
  .strict();
const pairedEnvelopeStructuralSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidencePairId: z.string().min(1),
    preservedBaseline: z
      .object({
        condition: z.literal("historical-server-only"),
        path: z.literal("evaluation/evidence/003/candidate-v1.json"),
        sha256: z.literal(
          "04cd236d6ddd27f30c21f7d332577ef3a91a3f55fc6ab79d1fd1f02d4900db2d",
        ),
        completedSpontaneousActivations: z.literal(0),
        relevantCases: z.literal(7),
      })
      .strict(),
    experiment: z
      .object({
        skillWireCommit: z.string().regex(/^[0-9a-f]{40}$/),
        codexCliVersion: z.string().min(1),
        model: z.object({ name: z.string(), version: z.string() }).strict(),
        reasoningSetting: z.string().min(1),
        serverPolicyVersion: z.literal("skillwire-activation-v1"),
        corpusId: z.literal("autonomous-activation-v1"),
        releaseSubsetId: z.literal("activation-release-candidate-pilot-v1"),
        catalogRelease: z.string().min(1),
        protocolVersion: z.string().min(1),
        evaluatorVersion: z.string().min(1),
        cleanProfileProcedureVersion: z.string().min(1),
        endpointUrlSha256: sha256Schema,
        authenticationMechanism: z.enum(["ephemeral-bearer-env", "oauth"]),
        caseIds: z.array(z.string()).length(15),
        serverOnlyInventory: emptyInventorySchema.extend({
          pluginSkills: z.array(z.string()).max(0),
        }),
        adapterInventory: emptyInventorySchema.extend({
          pluginSkills: z.tuple([
            z.literal(
              "skillwire-autonomous-activation:autonomous-skill-activation",
            ),
          ]),
        }),
      })
      .strict(),
    adapter: z
      .object({
        condition: z.literal("server-plus-adapter"),
        pluginId: z.literal("skillwire-autonomous-activation@skillwire"),
        pluginVersion: z.string().regex(/^\d+\.\d+\.\d+/),
        adapterPolicyVersion: z.literal("skillwire-codex-adapter-v1"),
        marketplaceName: z.literal("skillwire"),
        sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
        packageSha256: sha256Schema,
        dependencyUrlSha256: sha256Schema,
        dependencyState: z.enum([
          "equivalent-existing",
          "manager-added",
          "absent",
          "name-conflict",
          "unavailable",
          "unauthenticated",
          "incompatible",
          "rate-limited",
          "timed-out",
        ]),
        effectivePluginCount: z.literal(1),
      })
      .strict(),
    serverOnlyRun: z.unknown(),
    adapterRun: z.unknown(),
    claimEligibility: z
      .object({
        eligible: z.boolean(),
        evaluatedRelevantCases: z.number().int().min(0),
        diagnosticCodes: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

interface MutableEvidence {
  observations: {
    toolCalls: { sequence: number }[];
    verifiedSkillWireLoad: unknown;
    guidanceSource: string;
  }[];
  metrics: { spontaneousActivation: { rate: number } };
}

describe("manual autonomous-activation evidence", () => {
  it("keeps paired evidence structurally bound while preserving both v1 runs", () => {
    const paired = JSON.parse(
      readFileSync(fixture("paired-evidence-valid.v1.json"), "utf8"),
    ) as unknown;
    const parsed = pairedEnvelopeStructuralSchema.parse(paired);

    expect(parsed.experiment.caseIds).toHaveLength(15);
    expect(parsed.experiment.serverOnlyInventory.pluginSkills).toEqual([]);
    expect(parsed.experiment.adapterInventory.pluginSkills).toEqual([
      "skillwire-autonomous-activation:autonomous-skill-activation",
    ]);
    expect(
      validateActivationEvidence(parsed.serverOnlyRun, projectRoot).status,
    ).toBe("complete");
    expect(
      validateActivationEvidence(parsed.adapterRun, projectRoot).status,
    ).toBe("complete");
    expect(JSON.stringify(parsed)).not.toMatch(
      /(?:authorization["':]|api[_-]?key|-----BEGIN|\/home\/|[A-Z]:\\)/i,
    );
  });

  it("validates a complete paired experiment and derives eligibility only from exact traces", () => {
    const paired = createPairedActivationEvidenceFixture(projectRoot);
    const report = validatePairedActivationEvidence(paired, projectRoot);

    expect(paired.experiment.caseIds).toHaveLength(15);
    expect(report.status).toBe("complete");
    expect(report.serverOnly.metrics.spontaneousActivation).toEqual({
      numerator: 0,
      denominator: 8,
      rate: 0,
    });
    expect(report.adapter.metrics.spontaneousActivation).toEqual({
      numerator: 8,
      denominator: 8,
      rate: 1,
    });
    expect(report.claimEligibility).toEqual({
      eligible: true,
      evaluatedRelevantCases: 8,
      diagnosticCodes: [],
    });
  });

  it("rejects historical, case-set, control, inventory, release, and submitted-claim drift", () => {
    const cases = [
      {
        code: "PAIRED_EVIDENCE_SCHEMA_INVALID",
        mutate(
          value: ReturnType<typeof createPairedActivationEvidenceFixture>,
        ) {
          value.preservedBaseline.sha256 = "0".repeat(64) as never;
        },
      },
      {
        code: "PAIR_CASE_MISMATCH",
        mutate(
          value: ReturnType<typeof createPairedActivationEvidenceFixture>,
        ) {
          value.adapterRun.observations.reverse();
        },
      },
      {
        code: "PAIR_CONTROL_MISMATCH",
        mutate(
          value: ReturnType<typeof createPairedActivationEvidenceFixture>,
        ) {
          value.adapterRun.model.version = "different";
        },
      },
      {
        code: "INVENTORY_HASH_MISMATCH",
        mutate(
          value: ReturnType<typeof createPairedActivationEvidenceFixture>,
        ) {
          value.experiment.adapterInventory.inventorySha256 = "0".repeat(64);
        },
      },
      {
        code: "ADAPTER_RELEASE_MISMATCH",
        mutate(
          value: ReturnType<typeof createPairedActivationEvidenceFixture>,
        ) {
          value.adapter.packageSha256 = "0".repeat(64);
        },
      },
      {
        code: "CLAIM_ELIGIBILITY_MISMATCH",
        mutate(
          value: ReturnType<typeof createPairedActivationEvidenceFixture>,
        ) {
          value.claimEligibility = {
            eligible: false,
            evaluatedRelevantCases: 8,
            diagnosticCodes: ["spontaneous-activation-below-target"],
          };
        },
      },
    ];

    for (const entry of cases) {
      const paired = createPairedActivationEvidenceFixture(projectRoot);
      entry.mutate(paired);
      try {
        validatePairedActivationEvidence(paired, projectRoot);
        throw new Error(`Expected invalid pair: ${entry.code}`);
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceValidationError);
        expect((error as EvidenceValidationError).codes).toContain(entry.code);
      }
    }
  });

  it("withholds the claim for prose-only/search-only and incomplete observations", () => {
    const paired = createPairedActivationEvidenceFixture(projectRoot);
    const observation = paired.adapterRun.observations.find(
      ({ caseId }) => caseId === "auto-dependency-upgrade-planning-1",
    );
    if (observation === undefined) throw new Error("missing fixture case");
    observation.toolCalls = observation.toolCalls.slice(0, 1);
    observation.guidanceSource = "none";
    observation.verifiedSkillWireLoad = null;
    observation.completionEvidence = "none";
    paired.adapterRun.metrics = recomputeActivationEvidenceMetrics(
      paired.adapterRun,
      projectRoot,
    );
    paired.claimEligibility = derivePairedClaimEligibility(paired, projectRoot);

    const searchOnly = validatePairedActivationEvidence(paired, projectRoot);
    expect(searchOnly.claimEligibility).toMatchObject({ eligible: false });
    expect(searchOnly.claimEligibility.diagnosticCodes).toContain(
      "unattributable-success-trace",
    );

    const incomplete = createPairedActivationEvidenceFixture(projectRoot, {
      incompleteCaseId: "auto-dependency-upgrade-planning-1",
    });
    const incompleteReport = validatePairedActivationEvidence(
      incomplete,
      projectRoot,
    );
    expect(incompleteReport.status).toBe("incomplete");
    expect(incompleteReport.claimEligibility.eligible).toBe(false);
    expect(incompleteReport.claimEligibility.diagnosticCodes).toContain(
      "incomplete-observations",
    );
  });

  it.each([
    {
      condition: "failed-status",
      spontaneousActivation: { numerator: 7, denominator: 7, rate: 1 },
      correctSelectionAfterSearch: { numerator: 9, denominator: 9, rate: 1 },
    },
    {
      condition: "missing-completion-evidence",
      spontaneousActivation: { numerator: 7, denominator: 8, rate: 0.875 },
      correctSelectionAfterSearch: {
        numerator: 9,
        denominator: 10,
        rate: 0.9,
      },
    },
  ] as const)(
    "does not count an exact successful trace with $condition as attributable activation",
    ({ condition, spontaneousActivation, correctSelectionAfterSearch }) => {
      const paired = createPairedActivationEvidenceFixture(projectRoot);
      const observation = relevantObservation(paired, 0);
      if (condition === "failed-status") {
        observation.status = "failed";
      } else {
        observation.completionEvidence = "none";
      }
      recomputePair(paired);

      expect(paired.adapterRun.metrics.spontaneousActivation).toEqual(
        spontaneousActivation,
      );
      expect(paired.adapterRun.metrics.correctSelectionAfterSearch).toEqual(
        correctSelectionAfterSearch,
      );

      const report = validatePairedActivationEvidence(paired, projectRoot);
      expect(report.claimEligibility.eligible).toBe(false);
      expect(report.claimEligibility.diagnosticCodes).toContain(
        "unattributable-success-trace",
      );
      if (condition === "failed-status") {
        expect(report.claimEligibility.diagnosticCodes).toContain(
          "failed-observations",
        );
      }
    },
  );

  it.each([
    { caseId: "irrelevant-01", metric: "unnecessaryActivation" },
    {
      caseId: "ask-matt-without-intent-01",
      metric: "userRequestedIsolation",
    },
  ] as const)(
    "does not credit a failed $caseId negative control",
    ({ caseId, metric }) => {
      const paired = createPairedActivationEvidenceFixture(projectRoot);
      const observation = paired.adapterRun.observations.find(
        (entry) => entry.caseId === caseId,
      );
      if (observation === undefined)
        throw new Error("missing negative control");
      observation.status = "failed";
      recomputePair(paired);

      expect(paired.adapterRun.metrics[metric].denominator).toBe(
        metric === "unnecessaryActivation" ? 2 : 1,
      );
      const report = validatePairedActivationEvidence(paired, projectRoot);
      expect(report.claimEligibility.eligible).toBe(false);
      expect(report.claimEligibility.diagnosticCodes).toContain(
        "failed-observations",
      );
    },
  );

  it.each([
    {
      name: "load before search",
      order: ["load_skill", "search_skills", "read_skill_resource"],
      code: "LOAD_WITHOUT_PREVIEW",
    },
    {
      name: "resource before load",
      order: ["search_skills", "read_skill_resource", "load_skill"],
      code: "RESOURCE_WITHOUT_LOAD",
    },
  ] as const)("rejects $name", ({ order, code }) => {
    const paired = createPairedActivationEvidenceFixture(projectRoot);
    const observation = paired.adapterRun.observations.find(
      ({ caseId }) => caseId === "ask-matt-explicit-01",
    );
    if (observation === undefined) throw new Error("missing explicit case");
    const byName = new Map(
      observation.toolCalls.map((call) => [call.toolName, call]),
    );
    observation.toolCalls = order.map((toolName, index) => {
      const call = byName.get(toolName);
      if (call === undefined) throw new Error(`missing ${toolName}`);
      return { ...call, sequence: index + 1 };
    });
    recomputePair(paired);

    expect(paired.claimEligibility.eligible).toBe(false);
    expect(paired.claimEligibility.diagnosticCodes).toContain(
      "user-requested-isolation-failed",
    );
    try {
      validatePairedActivationEvidence(paired, projectRoot);
      throw new Error(`expected ${code}`);
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceValidationError);
      expect((error as EvidenceValidationError).codes).toContain(
        `ADAPTER_${code}`,
      );
    }
  });

  it("does not count an exact trace when activation instructions were not observed", () => {
    const paired = createPairedActivationEvidenceFixture(projectRoot);
    const observation = relevantObservation(paired, 0);
    observation.instructionsObserved = false;
    observation.instructionMethod = "not-observed";
    recomputePair(paired);

    expect(paired.adapterRun.metrics.spontaneousActivation).toEqual({
      numerator: 7,
      denominator: 8,
      rate: 0.875,
    });
    expect(paired.adapterRun.metrics.correctSelectionAfterSearch).toEqual({
      numerator: 9,
      denominator: 10,
      rate: 0.9,
    });

    const report = validatePairedActivationEvidence(paired, projectRoot);
    expect(report.adapter.diagnosticCodes).toContain(
      "INSTRUCTIONS_NOT_OBSERVED",
    );
    expect(report.claimEligibility.eligible).toBe(false);
    expect(report.claimEligibility.diagnosticCodes).toContain(
      "unattributable-success-trace",
    );
  });

  it("applies every acceptance threshold to completed adapter traces", () => {
    const passingPilot = createPairedActivationEvidenceFixture(projectRoot);
    const relevantAtThreshold = passingPilot.adapterRun.observations.filter(
      ({ caseId }) => caseId.startsWith("auto-") && !caseId.includes("overlap"),
    );
    for (const observation of relevantAtThreshold.slice(0, 1)) {
      removeActivation(observation);
    }
    recomputePair(passingPilot);
    expect(passingPilot.adapterRun.metrics.spontaneousActivation).toEqual({
      numerator: 7,
      denominator: 8,
      rate: 0.875,
    });
    expect(
      validatePairedActivationEvidence(passingPilot, projectRoot)
        .claimEligibility.eligible,
    ).toBe(true);

    const belowActivation = structuredClone(passingPilot);
    removeActivation(relevantObservation(belowActivation, 1));
    recomputePair(belowActivation);
    expect(belowActivation.claimEligibility.diagnosticCodes).toContain(
      "spontaneous-activation-below-target",
    );

    const unnecessary = createPairedActivationEvidenceFixture(projectRoot);
    for (const caseId of ["irrelevant-01", "irrelevant-02"]) {
      const observation = unnecessary.adapterRun.observations.find(
        (entry) => entry.caseId === caseId,
      );
      if (observation === undefined) throw new Error("missing irrelevant case");
      observation.toolCalls = [
        {
          sequence: 1,
          toolName: "search_skills",
          invocationContext: "automatic",
          result: "success",
        },
      ];
    }
    recomputePair(unnecessary);
    expect(unnecessary.claimEligibility.diagnosticCodes).toContain(
      "unnecessary-activation-above-target",
    );

    const isolation = createPairedActivationEvidenceFixture(projectRoot);
    const fixtures = validateActivationFixtures(
      loadActivationFixtures(projectRoot),
    );
    const explicit = fixtures.corpus.cases.find(
      ({ id }) => id === "ask-matt-explicit-01",
    );
    const noIntent = isolation.adapterRun.observations.find(
      ({ caseId }) => caseId === "ask-matt-without-intent-01",
    );
    const identity = explicit?.expectedCatalogMatch;
    if (identity === null || identity === undefined || noIntent === undefined) {
      throw new Error("missing isolation fixture");
    }
    noIntent.toolCalls = [
      {
        sequence: 1,
        toolName: "search_skills",
        invocationContext: "automatic",
        result: "success",
      },
      {
        sequence: 2,
        toolName: "load_skill",
        skill: identity,
        result: "success",
      },
    ];
    noIntent.guidanceSource = "skillwire";
    noIntent.verifiedSkillWireLoad = identity;
    recomputePair(isolation);
    expect(isolation.claimEligibility.diagnosticCodes).toContain(
      "user-requested-isolation-failed",
    );

    const explicitMissing = createPairedActivationEvidenceFixture(projectRoot);
    const explicitObservation = explicitMissing.adapterRun.observations.find(
      ({ caseId }) => caseId === "ask-matt-explicit-01",
    );
    if (explicitObservation === undefined)
      throw new Error("missing explicit observation");
    removeActivation(explicitObservation);
    recomputePair(explicitMissing);
    expect(explicitMissing.claimEligibility.diagnosticCodes).toContain(
      "user-requested-isolation-failed",
    );
  });

  it("accepts observed unnecessary resource evidence but blocks the claim", () => {
    const paired = createPairedActivationEvidenceFixture(projectRoot);
    const observation = paired.adapterRun.observations.find(
      ({ caseId }) => caseId === "ask-matt-explicit-02",
    );
    const identity = observation?.verifiedSkillWireLoad;
    if (
      observation === undefined ||
      identity === null ||
      identity === undefined
    ) {
      throw new Error("missing explicit fixture load");
    }
    observation.toolCalls.push({
      sequence: 3,
      toolName: "read_skill_resource",
      skill: identity,
      resourcePath: "REFERENCE.md",
      result: "success",
    });
    recomputePair(paired);

    const report = validatePairedActivationEvidence(paired, projectRoot);
    expect(report.adapter.diagnosticCodes).toEqual(
      expect.arrayContaining(["UNDECLARED_RESOURCE", "UNNECESSARY_RESOURCE"]),
    );
    expect(report.claimEligibility).toMatchObject({ eligible: false });
    expect(report.claimEligibility.diagnosticCodes).toContain(
      "progressive-loading-conformance-failed",
    );
  });

  it("rejects structurally invalid paired baseline and inventory evidence", () => {
    const invalid = JSON.parse(
      readFileSync(fixture("paired-evidence-invalid.v1.json"), "utf8"),
    ) as unknown;

    expect(() => pairedEnvelopeStructuralSchema.parse(invalid)).toThrow();
  });

  it("accepts and recomputes a privacy-safe actual-call trace", () => {
    const report = validateActivationEvidence(
      loadActivationEvidence(fixture("manual-evidence-valid.v1.json")),
      projectRoot,
    );

    expect(report.status).toBe("complete");
    expect(report.observationCount).toBe(1);
    expect(report.metrics).toEqual({
      spontaneousActivation: { numerator: 1, denominator: 1, rate: 1 },
      correctSelectionAfterSearch: { numerator: 1, denominator: 1, rate: 1 },
      unnecessaryActivation: { numerator: 0, denominator: 0, rate: 0 },
      userRequestedIsolation: { numerator: 0, denominator: 0, rate: 0 },
      progressiveLoadingConformance: {
        numerator: 1,
        denominator: 1,
        rate: 1,
      },
      zeroClientWrites: true,
      zeroAgentFacingGithubRequests: true,
      localOverlap: {
        equivalentCases: 0,
        overlappingCases: 0,
        violations: 0,
      },
    });
    expect(report.diagnosticCodes).toEqual([]);
  });

  it("accepts an honest incomplete run without treating it as success", () => {
    const report = validateActivationEvidence(
      loadActivationEvidence(fixture("manual-evidence-incomplete.v1.json")),
      projectRoot,
    );

    expect(report.status).toBe("incomplete");
    expect(report.metrics.spontaneousActivation.denominator).toBe(0);
    expect(report.diagnosticCodes).toEqual([
      "INSTRUCTIONS_NOT_OBSERVED",
      "INCOMPLETE_TRACE",
    ]);
  });

  it("rejects every frozen privacy, loop, attribution, and local override violation", () => {
    const invalid = JSON.parse(
      readFileSync(fixture("manual-evidence-invalid.v1.json"), "utf8"),
    ) as {
      fixtures: { id: string; expectedCode: string; evidence: unknown }[];
    };

    for (const entry of invalid.fixtures) {
      try {
        validateActivationEvidence(entry.evidence, projectRoot);
        throw new Error(`Expected invalid evidence: ${entry.id}`);
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceValidationError);
        expect((error as EvidenceValidationError).codes).toContain(
          entry.expectedCode,
        );
      }
    }
  });

  it("rejects duplicate sequence numbers, unverifiable loads, and aggregate-rate claims", () => {
    const cases = [
      {
        code: "DUPLICATE_SEQUENCE",
        mutate(evidence: MutableEvidence) {
          const observation = evidence.observations[0];
          const load = observation?.toolCalls[1];
          if (load === undefined) throw new Error("Expected load fixture call");
          load.sequence = 1;
        },
      },
      {
        code: "UNATTRIBUTABLE_OUTCOME",
        mutate(evidence: MutableEvidence) {
          const observation = evidence.observations[0];
          if (observation === undefined)
            throw new Error("Expected evidence observation");
          observation.verifiedSkillWireLoad = null;
          observation.guidanceSource = "none";
        },
      },
      {
        code: "METRICS_MISMATCH",
        mutate(evidence: MutableEvidence) {
          evidence.metrics.spontaneousActivation.rate = 0;
        },
      },
    ];

    for (const entry of cases) {
      const evidence = loadActivationEvidence(
        fixture("manual-evidence-valid.v1.json"),
      ) as MutableEvidence;
      entry.mutate(evidence);
      try {
        validateActivationEvidence(evidence, projectRoot);
        throw new Error(`Expected invalid evidence: ${entry.code}`);
      } catch (error) {
        expect(error).toBeInstanceOf(EvidenceValidationError);
        expect((error as EvidenceValidationError).codes).toContain(entry.code);
      }
    }
  });
});

function relevantObservation(
  pair: ReturnType<typeof createPairedActivationEvidenceFixture>,
  index: number,
) {
  const observations = pair.adapterRun.observations.filter(
    ({ caseId }) => caseId.startsWith("auto-") && !caseId.includes("overlap"),
  );
  const observation = observations[index];
  if (observation === undefined)
    throw new Error("missing relevant observation");
  return observation;
}

function removeActivation(
  observation: ReturnType<
    typeof createPairedActivationEvidenceFixture
  >["adapterRun"]["observations"][number],
): void {
  observation.toolCalls = [];
  observation.guidanceSource = "none";
  observation.verifiedSkillWireLoad = null;
  observation.completionEvidence = "none";
}

function recomputePair(
  pair: ReturnType<typeof createPairedActivationEvidenceFixture>,
): void {
  pair.adapterRun.metrics = recomputeActivationEvidenceMetrics(
    pair.adapterRun,
    projectRoot,
  );
  pair.claimEligibility = derivePairedClaimEligibility(pair, projectRoot);
}
