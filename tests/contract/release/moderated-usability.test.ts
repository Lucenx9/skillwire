import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  calculateModeratedUsabilityCohort,
  type ModeratedUsabilityCohort,
  ModeratedUsabilityCohortSchema,
  type ModeratedUsabilityParticipant,
  validateModeratedUsabilityCohort,
} from "../../../src/onboarding/domain/moderated-usability.js";

const SOURCE_COMMIT = "1".repeat(40);
const DOCUMENT_SHA256 = "2".repeat(64);
const MANIFEST_SHA256 = "3".repeat(64);

const assets = [
  "skillwire-0.2.0-linux-amd64.release.json",
  "skillwire-0.2.0-linux-amd64.release.sigstore.json",
  "skillwire-0.2.0-linux-amd64.tar.zst",
  "skillwire-0.2.0-linux-arm64.release.json",
  "skillwire-0.2.0-linux-arm64.release.sigstore.json",
  "skillwire-0.2.0-linux-arm64.tar.zst",
  "skillwire-trust-policy-v1.json",
].map((path, index) => ({
  path,
  size: 1024 + index,
  sha256:
    index === 0 ? MANIFEST_SHA256 : ((index + 4) % 16).toString(16).repeat(64),
}));

function syntheticParticipant(index: number): ModeratedUsabilityParticipant {
  const startedAt = new Date(Date.UTC(2026, 7, 15, 10, index, 0));
  const endedAt = new Date(startedAt.getTime() + 10 * 60_000);
  const passed = { status: "passed" as const, publicErrorCodes: [] };
  return {
    participantId: `participant-${index.toString(16).padStart(16, "0")}`,
    independent: true,
    previouslyInstalledSkillWire: false,
    attemptNumber: 1,
    replacementForParticipantId: null,
    exclusionReason: null,
    environment: {
      environmentId: `environment-${index.toString(16).padStart(16, "0")}`,
      clean: true,
      operatingSystem: { id: "ubuntu" as const, version: "24.04" as const },
      architecture: "amd64" as const,
      dockerMode: "rootless" as const,
    },
    startingState: {
      skillWireAbsent: true,
      serviceAbsent: true,
      selectedClientHasNoSkillWireIntegration: true,
      noRetainedSkillWireData: true,
    },
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    elapsedMilliseconds: endedAt.getTime() - startedAt.getTime(),
    release: {
      version: "0.2.0",
      tag: "self-hosted-v0.2.0",
      sourceCommit: SOURCE_COMMIT,
      manifestSha256: MANIFEST_SHA256,
      assets,
    },
    documentation: {
      path: "distribution/self-hosted/README.md",
      sha256: DOCUMENT_SHA256,
    },
    usedOnlyPublishedQuickstart: true,
    manualConfigurationEdited: false,
    milestones: {
      releaseVerified: passed,
      serviceReady: passed,
      clientIntegrated: passed,
      installationStateIdentified: passed,
      nextSafeRecoveryActionIdentified: passed,
      sixToolDiscovery: passed,
      mcpSearch: passed,
      exactSkillLoad: passed,
      optionalResourceJourney: passed,
      cleanup: passed,
    },
    publicErrors: [],
    moderatorInterventions: [],
    documentationClarifications: [],
    serviceReady: true,
    discoveredTools: [
      "search_skills",
      "load_skill",
      "get_skill_resource",
      "import_repository",
      "list_repositories",
      "remove_repository",
    ] as const,
    journey: {
      searchCompleted: true,
      exactSkillLoaded: true,
      optionalResourceOutcome: "completed" as const,
    },
    cleanup: { verified: true, completedAt: endedAt.toISOString() },
    completed: true,
    unassisted: true,
  };
}

function syntheticCohort(): ModeratedUsabilityCohort {
  const participants = Array.from({ length: 10 }, (_, index) =>
    syntheticParticipant(index + 1),
  );
  return {
    schemaVersion: "skillwire.moderated-usability/v1" as const,
    evidenceKind: "synthetic-fixture" as const,
    cohortId: "cohort-0000000000000001",
    targetMilliseconds: 15 * 60_000,
    release: {
      version: "0.2.0",
      tag: "self-hosted-v0.2.0",
      sourceCommit: SOURCE_COMMIT,
      assets,
    },
    documentation: {
      path: "distribution/self-hosted/README.md",
      sha256: DOCUMENT_SHA256,
    },
    participants,
    aggregation: {
      cohortSize: 10,
      completedWithinTarget: 10,
      sc001Required: 10,
      sc001Passed: true,
      unassistedCompletions: 10,
      sc014Required: 9,
      sc014Passed: true,
    },
  };
}

function setInvalid(target: unknown, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

describe("moderated self-hosted usability certification", () => {
  it("calculates SC-001 as 10/10 and SC-014 as at least 9/10", () => {
    const cohort = validateModeratedUsabilityCohort(syntheticCohort());
    expect(calculateModeratedUsabilityCohort(cohort.participants)).toEqual({
      cohortSize: 10,
      completedWithinTarget: 10,
      sc001Required: 10,
      sc001Passed: true,
      unassistedCompletions: 10,
      sc014Required: 9,
      sc014Passed: true,
    });

    const oneIntervention = structuredClone(syntheticCohort());
    const participant = oneIntervention.participants[0];
    if (participant === undefined)
      throw new Error("Synthetic participant missing");
    participant.moderatorInterventions.push({
      occurredAt: participant.startedAt,
      category: "procedural-instruction",
      milestone: "serviceReady",
      publicCode: "MODERATOR_PROCEDURE_REQUIRED",
    });
    participant.unassisted = false;
    oneIntervention.aggregation.unassistedCompletions = 9;
    expect(
      validateModeratedUsabilityCohort(oneIntervention).aggregation.sc014Passed,
    ).toBe(true);
  });

  it("counts timeout, abandonment, and unrecovered errors as failures", () => {
    const cohort = structuredClone(syntheticCohort());
    const participant = cohort.participants[0];
    if (participant === undefined)
      throw new Error("Synthetic participant missing");
    participant.milestones.serviceReady = {
      status: "timeout",
      publicErrorCodes: ["SERVICE_READINESS_TIMEOUT"],
    };
    participant.publicErrors.push({
      code: "SERVICE_READINESS_TIMEOUT",
      milestone: "serviceReady",
      recovered: false,
    });
    participant.milestones.clientIntegrated = {
      status: "abandoned",
      publicErrorCodes: ["JOURNEY_ABANDONED"],
    };
    participant.milestones.sixToolDiscovery = {
      status: "abandoned",
      publicErrorCodes: ["JOURNEY_ABANDONED"],
    };
    participant.milestones.mcpSearch = {
      status: "abandoned",
      publicErrorCodes: ["JOURNEY_ABANDONED"],
    };
    participant.milestones.exactSkillLoad = {
      status: "abandoned",
      publicErrorCodes: ["JOURNEY_ABANDONED"],
    };
    participant.milestones.optionalResourceJourney = {
      status: "not-applicable",
      publicErrorCodes: [],
    };
    for (const milestone of [
      "clientIntegrated",
      "sixToolDiscovery",
      "mcpSearch",
      "exactSkillLoad",
    ] as const) {
      participant.publicErrors.push({
        code: "JOURNEY_ABANDONED",
        milestone,
        recovered: false,
      });
    }
    participant.serviceReady = false;
    participant.discoveredTools = [];
    participant.journey.searchCompleted = false;
    participant.journey.exactSkillLoaded = false;
    participant.journey.optionalResourceOutcome = "not-applicable";
    participant.completed = false;
    participant.unassisted = false;
    cohort.aggregation.completedWithinTarget = 9;
    cohort.aggregation.sc001Passed = false;
    cohort.aggregation.unassistedCompletions = 9;

    expect(validateModeratedUsabilityCohort(cohort).aggregation).toMatchObject({
      cohortSize: 10,
      completedWithinTarget: 9,
      sc001Required: 10,
      sc001Passed: false,
      unassistedCompletions: 9,
      sc014Required: 9,
      sc014Passed: true,
    });
  });

  it("forbids replacement, rerun, post-start exclusion, and duplicate identity", () => {
    const replacement = structuredClone(syntheticCohort());
    const participant = replacement.participants[0];
    if (participant === undefined)
      throw new Error("Synthetic participant missing");
    setInvalid(
      participant,
      "replacementForParticipantId",
      replacement.participants[1]?.participantId ?? null,
    );
    expect(() => validateModeratedUsabilityCohort(replacement)).toThrow(
      /replacement/i,
    );

    const rerun = structuredClone(syntheticCohort());
    setInvalid(rerun.participants[0], "attemptNumber", 2);
    expect(() => validateModeratedUsabilityCohort(rerun)).toThrow();

    const excluded = structuredClone(syntheticCohort());
    setInvalid(
      excluded.participants[0],
      "exclusionReason",
      "unsupported-environment",
    );
    expect(() => validateModeratedUsabilityCohort(excluded)).toThrow(
      /exclude/i,
    );

    const duplicate = structuredClone(syntheticCohort());
    const first = duplicate.participants[0];
    const second = duplicate.participants[1];
    if (first === undefined || second === undefined)
      throw new Error("Synthetic participants missing");
    second.participantId = first.participantId;
    expect(() => validateModeratedUsabilityCohort(duplicate)).toThrow(
      /unique/i,
    );
  });

  it("requires one fixed release, tag, asset set, documentation, and clean supported environment", () => {
    const cohort = structuredClone(syntheticCohort());
    const participant = cohort.participants[0];
    if (participant === undefined)
      throw new Error("Synthetic participant missing");
    participant.release.tag = "self-hosted-v0.1.0";
    expect(() => validateModeratedUsabilityCohort(cohort)).toThrow(
      /release identity/i,
    );
  });

  it("records visible-document clarification separately without hiding procedural intervention", () => {
    const cohort = structuredClone(syntheticCohort());
    const participant = cohort.participants[0];
    if (participant === undefined)
      throw new Error("Synthetic participant missing");
    participant.documentationClarifications.push({
      occurredAt: participant.startedAt,
      criterion: "visible-document-location-only",
      documentPath: "distribution/self-hosted/README.md",
      sectionId: "verify-the-release",
    });
    expect(
      validateModeratedUsabilityCohort(cohort).aggregation.sc014Passed,
    ).toBe(true);
  });

  it("rejects privacy-sensitive or unknown evidence fields", () => {
    const cohort = syntheticCohort() as Record<string, unknown>;
    cohort["promptContent"] = "must never be collected";
    expect(() => ModeratedUsabilityCohortSchema.parse(cohort)).toThrow();
  });

  it("ships a strict privacy-safe JSON evidence schema", async () => {
    const schema = JSON.parse(
      await readFile(
        "distribution/self-hosted/moderated-usability.schema.json",
        "utf8",
      ),
    ) as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty("promptContent");
    expect(schema.properties).not.toHaveProperty("credentialValue");
  });
});
