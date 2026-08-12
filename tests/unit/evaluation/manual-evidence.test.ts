import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  EvidenceValidationError,
  loadActivationEvidence,
  validateActivationEvidence,
} from "../../../src/evaluation/activation-evidence.js";

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
        catalogRelease: z.string().min(1),
        protocolVersion: z.string().min(1),
        evaluatorVersion: z.string().min(1),
        cleanProfileProcedureVersion: z.string().min(1),
        endpointUrlSha256: sha256Schema,
        authenticationMechanism: z.enum(["ephemeral-bearer-env", "oauth"]),
        caseIds: z.array(z.string()).min(50),
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

    expect(parsed.experiment.caseIds).toHaveLength(50);
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
