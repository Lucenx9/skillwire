import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeInventorySha256,
  derivePairedClaimEligibility,
  recomputeActivationEvidenceMetrics,
  type ActivationEvidence,
  type PairedActivationEvidence,
} from "../../src/evaluation/activation-evidence.js";
import {
  loadActivationFixtures,
  validateActivationFixtures,
  type ActivationCorpus,
} from "../../src/evaluation/activation-corpus-runner.js";
import {
  ACTIVATION_RELEASE_SUBSET_ID,
  validateActivationReleaseSubset,
} from "../../src/evaluation/activation-release-subset.js";
import {
  CANONICAL_SKILLWIRE_MCP_URL,
  CODEX_ADAPTER_SOURCE_COMMIT,
} from "../../src/evaluation/codex-adapter-package.js";
import { ACTIVATION_INSTRUCTIONS } from "../../src/transport/mcp/activation-policy.js";

const PRIVACY_DECLARATION = {
  containsRawPrompts: false,
  containsTaskSummaries: false,
  containsRepositoryHashes: false,
  containsLocalPaths: false,
  containsSkillContent: false,
  containsCredentialsOrHeaders: false,
} as const;

export interface PairedFixtureOptions {
  readonly adapterActivates?: boolean;
  readonly incompleteCaseId?: string;
}

export function createPairedActivationEvidenceFixture(
  projectRoot: string,
  options: PairedFixtureOptions = {},
): PairedActivationEvidence {
  const fixtures = validateActivationFixtures(
    loadActivationFixtures(projectRoot),
  );
  const releaseSubset = validateActivationReleaseSubset(
    projectRoot,
    fixtures.corpus,
  );
  const casesById = new Map(
    fixtures.corpus.cases.map((entry) => [entry.id, entry]),
  );
  const cases = releaseSubset.caseIds.map((caseId) => {
    const activationCase = casesById.get(caseId);
    if (activationCase === undefined) throw new Error("release case missing");
    return activationCase;
  });
  const caseIds = [...releaseSubset.caseIds];
  const release = JSON.parse(
    readFileSync(
      join(
        projectRoot,
        "distribution/codex-marketplace/release-integrity.json",
      ),
      "utf8",
    ),
  ) as { pluginVersion: string; packageSha256: string };
  const serverOnlyInventoryContent = {
    platformBaselineSkills: ["codex-system-baseline"],
    userSkills: [],
    repositorySkills: [],
    adminSkills: [],
    pluginSkills: [],
    mcpServers: ["skillwire"] as ["skillwire"],
  };
  const adapterInventoryContent = {
    ...serverOnlyInventoryContent,
    pluginSkills: [
      "skillwire-autonomous-activation:autonomous-skill-activation",
    ] as ["skillwire-autonomous-activation:autonomous-skill-activation"],
  };
  const runControls = {
    schemaVersion: 1 as const,
    recordedAt: "2026-08-12T12:00:00.000Z",
    policyVersion: "skillwire-activation-v1" as const,
    corpusId: "autonomous-activation-v1" as const,
    catalogRelease: fixtures.corpus.catalogRelease,
    protocolVersion: "2026-07-28" as const,
    harness: { name: "codex-cli", version: "0.147.0" },
    model: { name: "fixture-model", version: "1.0.0" },
    localInventoryVersion: fixtures.localInventory.inventoryId,
    evaluatorVersion: "activation-pair-evaluator-v1",
    traceSource: "observer-proxy" as const,
    instructionsSha256: createHash("sha256")
      .update(ACTIVATION_INSTRUCTIONS)
      .digest("hex"),
    privacyDeclaration: PRIVACY_DECLARATION,
  };
  const emptyMetrics: ActivationEvidence["metrics"] = {
    spontaneousActivation: { numerator: 0, denominator: 0, rate: 0 },
    correctSelectionAfterSearch: { numerator: 0, denominator: 0, rate: 0 },
    unnecessaryActivation: { numerator: 0, denominator: 0, rate: 0 },
    userRequestedIsolation: { numerator: 0, denominator: 0, rate: 0 },
    progressiveLoadingConformance: {
      numerator: 0,
      denominator: 0,
      rate: 0,
    },
    zeroClientWrites: true,
    zeroAgentFacingGithubRequests: true,
    localOverlap: { equivalentCases: 0, overlappingCases: 0, violations: 0 },
  };
  const serverOnlyRun: ActivationEvidence = {
    ...runControls,
    harness: { ...runControls.harness },
    model: { ...runControls.model },
    privacyDeclaration: { ...runControls.privacyDeclaration },
    evidenceId: "paired-server-only-fixture-v1",
    environmentProfile: "paired-server-only-clean-v1",
    observations: cases.map((entry) =>
      createObservation(entry, false, options.incompleteCaseId),
    ),
    metrics: emptyMetrics,
  };
  const adapterRun: ActivationEvidence = {
    ...runControls,
    harness: { ...runControls.harness },
    model: { ...runControls.model },
    privacyDeclaration: { ...runControls.privacyDeclaration },
    evidenceId: "paired-adapter-fixture-v1",
    environmentProfile: "paired-adapter-clean-v1",
    observations: cases.map((entry) =>
      createObservation(
        entry,
        options.adapterActivates ?? true,
        options.incompleteCaseId,
      ),
    ),
    metrics: emptyMetrics,
  };
  serverOnlyRun.metrics = recomputeActivationEvidenceMetrics(
    serverOnlyRun,
    projectRoot,
  );
  adapterRun.metrics = recomputeActivationEvidenceMetrics(
    adapterRun,
    projectRoot,
  );

  const pair: PairedActivationEvidence = {
    schemaVersion: 1,
    evidencePairId: "paired-activation-fixture-v1",
    preservedBaseline: {
      condition: "historical-server-only",
      path: "evaluation/evidence/003/candidate-v1.json",
      sha256:
        "04cd236d6ddd27f30c21f7d332577ef3a91a3f55fc6ab79d1fd1f02d4900db2d",
      completedSpontaneousActivations: 0,
      relevantCases: 7,
    },
    experiment: {
      skillWireCommit: CODEX_ADAPTER_SOURCE_COMMIT,
      codexCliVersion: "0.147.0",
      model: { ...runControls.model },
      reasoningSetting: "fixture",
      serverPolicyVersion: "skillwire-activation-v1",
      corpusId: "autonomous-activation-v1",
      releaseSubsetId: ACTIVATION_RELEASE_SUBSET_ID,
      catalogRelease: fixtures.corpus.catalogRelease,
      protocolVersion: runControls.protocolVersion,
      evaluatorVersion: runControls.evaluatorVersion,
      cleanProfileProcedureVersion: "clean-profile-v2",
      endpointUrlSha256: createHash("sha256")
        .update(CANONICAL_SKILLWIRE_MCP_URL)
        .digest("hex"),
      authenticationMechanism: "ephemeral-bearer-env",
      caseIds,
      serverOnlyInventory: {
        ...serverOnlyInventoryContent,
        inventorySha256: computeInventorySha256(serverOnlyInventoryContent),
      },
      adapterInventory: {
        ...adapterInventoryContent,
        inventorySha256: computeInventorySha256(adapterInventoryContent),
      },
    },
    adapter: {
      condition: "server-plus-adapter",
      pluginId: "skillwire-autonomous-activation@skillwire",
      pluginVersion: release.pluginVersion,
      adapterPolicyVersion: "skillwire-codex-adapter-v1",
      marketplaceName: "skillwire",
      sourceCommit: CODEX_ADAPTER_SOURCE_COMMIT,
      packageSha256: release.packageSha256,
      dependencyUrlSha256: createHash("sha256")
        .update(CANONICAL_SKILLWIRE_MCP_URL)
        .digest("hex"),
      dependencyState: "equivalent-existing",
      effectivePluginCount: 1,
    },
    serverOnlyRun,
    adapterRun,
    claimEligibility: {
      eligible: false,
      evaluatedRelevantCases: 0,
      diagnosticCodes: ["insufficient-relevant-cases"],
    },
  };
  pair.claimEligibility = derivePairedClaimEligibility(pair, projectRoot);
  return pair;
}

function createObservation(
  activationCase: ActivationCorpus["cases"][number],
  activate: boolean,
  incompleteCaseId?: string,
): ActivationEvidence["observations"][number] {
  const shouldActivate =
    activate &&
    (activationCase.scenarioClass === "automatic-relevant" ||
      activationCase.scenarioClass === "user-requested-explicit") &&
    activationCase.failureMode === undefined;
  const identity = activationCase.expectedCatalogMatch;
  if (shouldActivate && identity === null) {
    throw new Error("fixture activation requires an exact catalog identity");
  }
  const toolCalls: ActivationEvidence["observations"][number]["toolCalls"] =
    shouldActivate && identity !== null
      ? [
          {
            sequence: 1,
            toolName: "search_skills",
            invocationContext: activationCase.invocationContext,
            result: "success",
          },
          {
            sequence: 2,
            toolName: "load_skill",
            skill: identity,
            result: "success",
          },
          ...activationCase.expectedBehavior.resourcePaths.map(
            (resourcePath, index) => ({
              sequence: index + 3,
              toolName: "read_skill_resource" as const,
              skill: identity,
              resourcePath,
              result: "success" as const,
            }),
          ),
        ]
      : [];
  const status =
    activationCase.id === incompleteCaseId ? "incomplete" : "completed";
  const missingExpectedSearch =
    !shouldActivate && activationCase.expectedBehavior.search === "call";
  return {
    caseId: activationCase.id,
    instructionsObserved: true,
    instructionMethod: "server/discover",
    status,
    toolCalls,
    guidanceSource: shouldActivate ? "skillwire" : "none",
    verifiedSkillWireLoad: shouldActivate ? identity : null,
    completionEvidence: shouldActivate ? "observed-completion" : "none",
    positiveOutcomeRecorded: false,
    clientTreeWrites: 0,
    githubRequests: 0,
    diagnosticCodes: [
      ...(missingExpectedSearch ? (["EXPECTED_SEARCH_MISSING"] as const) : []),
      ...(status === "incomplete" ? (["INCOMPLETE_TRACE"] as const) : []),
    ],
  };
}
