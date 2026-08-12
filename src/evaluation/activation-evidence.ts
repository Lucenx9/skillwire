import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { ACTIVATION_INSTRUCTIONS } from "../transport/mcp/activation-policy.js";
import {
  loadActivationFixtures,
  validateActivationFixtures,
  type ActivationCorpus,
} from "./activation-corpus-runner.js";
import {
  ACTIVATION_RELEASE_SUBSET_ID,
  validateActivationReleaseSubset,
} from "./activation-release-subset.js";
import {
  CANONICAL_SKILLWIRE_MCP_URL,
  validateCodexAdapterIntegrityManifest,
} from "./codex-adapter-package.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// eslint-disable-next-line no-control-regex -- the evidence contract rejects NUL.
const RESOURCE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000]+$/;

const identitySchema = z
  .object({
    skillId: z.string().min(1).max(256),
    revision: z.string().min(1).max(256),
    revisionSha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

const diagnosticCodeSchema = z.enum([
  "EXPECTED_SEARCH_MISSING",
  "UNNECESSARY_SEARCH",
  "REPEATED_SEARCH",
  "WRONG_INVOCATION_CONTEXT",
  "USER_ONLY_LEAK",
  "WRONG_SKILL",
  "REPEATED_LOAD",
  "LOAD_WITHOUT_PREVIEW",
  "RESOURCE_WITHOUT_LOAD",
  "UNDECLARED_RESOURCE",
  "DUPLICATE_RESOURCE",
  "UNNECESSARY_RESOURCE",
  "LOCAL_PRECEDENCE_VIOLATION",
  "EXPLICIT_LOCAL_OVERRIDE",
  "RETRY_AFTER_FAILURE",
  "UNATTRIBUTABLE_OUTCOME",
  "UNSUPPORTED_POSITIVE_OUTCOME",
  "CLIENT_TREE_WRITE",
  "AGENT_FACING_GITHUB_REQUEST",
  "INSTRUCTIONS_NOT_OBSERVED",
  "INCOMPLETE_TRACE",
]);

export type EvidenceDiagnosticCode = z.infer<typeof diagnosticCodeSchema>;

const toolCallSchema = z
  .object({
    sequence: z.number().int().min(1),
    toolName: z.enum([
      "search_skills",
      "load_skill",
      "read_skill_resource",
      "list_repo_memory",
      "record_skill_outcome",
      "forget_repo_memory",
    ]),
    invocationContext: z.enum(["automatic", "user-requested"]).optional(),
    skill: identitySchema.optional(),
    resourcePath: z
      .string()
      .min(1)
      .max(1024)
      .regex(RESOURCE_PATH_PATTERN)
      .optional(),
    result: z.enum(["success", "error"]),
    errorCode: z
      .enum([
        "UNAUTHENTICATED",
        "RATE_LIMITED",
        "INVALID_ARGUMENT",
        "NOT_FOUND",
        "REVISION_UNAVAILABLE",
        "RESOURCE_REJECTED",
        "MEMORY_CONFLICT",
        "ERASURE_INCOMPLETE",
        "INTERNAL",
      ])
      .optional(),
  })
  .strict();

const observationSchema = z
  .object({
    caseId: z.string().min(1).max(128).regex(CASE_ID_PATTERN),
    instructionsObserved: z.boolean(),
    instructionMethod: z.enum([
      "initialize",
      "server/discover",
      "not-observed",
    ]),
    status: z.enum(["completed", "failed", "incomplete"]),
    toolCalls: z.array(toolCallSchema),
    guidanceSource: z.enum([
      "none",
      "local",
      "skillwire",
      "local-and-skillwire",
    ]),
    selectedLocalFixtureId: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_ID_PATTERN)
      .optional(),
    verifiedSkillWireLoad: identitySchema.nullable(),
    completionEvidence: z.enum([
      "none",
      "observed-completion",
      "explicit-user-feedback",
    ]),
    positiveOutcomeRecorded: z.boolean(),
    clientTreeWrites: z.number().int().min(0),
    githubRequests: z.number().int().min(0),
    diagnosticCodes: z.array(diagnosticCodeSchema),
  })
  .strict();

const ratioMetricSchema = z
  .object({
    numerator: z.number().int().min(0),
    denominator: z.number().int().min(0),
    rate: z.number().min(0).max(1),
  })
  .strict();

const metricsSchema = z
  .object({
    spontaneousActivation: ratioMetricSchema,
    correctSelectionAfterSearch: ratioMetricSchema,
    unnecessaryActivation: ratioMetricSchema,
    userRequestedIsolation: ratioMetricSchema,
    progressiveLoadingConformance: ratioMetricSchema,
    zeroClientWrites: z.boolean(),
    zeroAgentFacingGithubRequests: z.boolean(),
    localOverlap: z
      .object({
        equivalentCases: z.number().int().min(0),
        overlappingCases: z.number().int().min(0),
        violations: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

const activationEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceId: z.string().min(1).max(128).regex(SAFE_ID_PATTERN),
    recordedAt: z.iso.datetime(),
    policyVersion: z.literal("skillwire-activation-v1"),
    corpusId: z.literal("autonomous-activation-v1"),
    catalogRelease: z.string().min(1).max(128).regex(SAFE_ID_PATTERN),
    protocolVersion: z.enum(["2025-11-25", "2026-07-28"]),
    harness: z
      .object({
        name: z.string().min(1).max(128),
        version: z.string().min(1).max(128),
      })
      .strict(),
    model: z
      .object({
        name: z.string().min(1).max(128),
        version: z.string().min(1).max(128),
      })
      .strict(),
    environmentProfile: z.string().min(1).max(128).regex(SAFE_ID_PATTERN),
    localInventoryVersion: z.string().min(1).max(128).regex(SAFE_ID_PATTERN),
    evaluatorVersion: z.string().min(1).max(128).regex(SAFE_ID_PATTERN),
    traceSource: z.enum(["harness-export", "observer-proxy"]),
    instructionsSha256: z.string().regex(SHA256_PATTERN),
    privacyDeclaration: z
      .object({
        containsRawPrompts: z.literal(false),
        containsTaskSummaries: z.literal(false),
        containsRepositoryHashes: z.literal(false),
        containsLocalPaths: z.literal(false),
        containsSkillContent: z.literal(false),
        containsCredentialsOrHeaders: z.literal(false),
      })
      .strict(),
    observations: z.array(observationSchema).min(1),
    metrics: metricsSchema,
  })
  .strict();

const inventoryNamesSchema = z
  .array(z.string().min(1).max(256))
  .refine(
    (items) => new Set(items).size === items.length,
    "inventory names must be unique",
  );

const effectiveInventorySchema = z
  .object({
    platformBaselineSkills: inventoryNamesSchema,
    userSkills: inventoryNamesSchema.max(0),
    repositorySkills: inventoryNamesSchema.max(0),
    adminSkills: inventoryNamesSchema.max(0),
    pluginSkills: inventoryNamesSchema,
    mcpServers: z.tuple([z.literal("skillwire")]),
    inventorySha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

const claimDiagnosticCodeSchema = z.enum([
  "insufficient-relevant-cases",
  "spontaneous-activation-below-target",
  "correct-selection-below-target",
  "unnecessary-activation-above-target",
  "user-requested-isolation-failed",
  "client-write-observed",
  "unattributable-success-trace",
  "progressive-loading-conformance-failed",
  "unmatched-pair",
  "incomplete-observations",
]);

const claimEligibilitySchema = z
  .object({
    eligible: z.boolean(),
    evaluatedRelevantCases: z.number().int().min(0),
    diagnosticCodes: z
      .array(claimDiagnosticCodeSchema)
      .refine(
        (items) => new Set(items).size === items.length,
        "claim diagnostic codes must be unique",
      ),
  })
  .strict();

const pairedActivationEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidencePairId: z.string().min(1).max(128).regex(SAFE_ID_PATTERN),
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
        codexCliVersion: z.string().min(1).max(64),
        model: z
          .object({
            name: z.string().min(1).max(128),
            version: z.string().min(1).max(128),
          })
          .strict(),
        reasoningSetting: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
        serverPolicyVersion: z.literal("skillwire-activation-v1"),
        corpusId: z.literal("autonomous-activation-v1"),
        releaseSubsetId: z.literal(ACTIVATION_RELEASE_SUBSET_ID),
        catalogRelease: z.string().min(1).max(128),
        protocolVersion: z.string().min(1).max(64),
        evaluatorVersion: z.string().min(1).max(128).regex(SAFE_ID_PATTERN),
        cleanProfileProcedureVersion: z
          .string()
          .min(1)
          .max(128)
          .regex(SAFE_ID_PATTERN),
        endpointUrlSha256: z.string().regex(SHA256_PATTERN),
        authenticationMechanism: z.enum(["ephemeral-bearer-env", "oauth"]),
        caseIds: z
          .array(z.string().min(1).max(128).regex(SAFE_ID_PATTERN))
          .length(15)
          .refine(
            (items) => new Set(items).size === items.length,
            "paired case IDs must be unique",
          ),
        serverOnlyInventory: effectiveInventorySchema.extend({
          pluginSkills: inventoryNamesSchema.max(0),
        }),
        adapterInventory: effectiveInventorySchema.extend({
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
        pluginVersion: z
          .string()
          .max(64)
          .regex(
            /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
          ),
        adapterPolicyVersion: z.literal("skillwire-codex-adapter-v1"),
        marketplaceName: z.literal("skillwire"),
        sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
        packageSha256: z.string().regex(SHA256_PATTERN),
        dependencyUrlSha256: z.string().regex(SHA256_PATTERN),
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
    serverOnlyRun: activationEvidenceSchema,
    adapterRun: activationEvidenceSchema,
    claimEligibility: claimEligibilitySchema,
  })
  .strict();

export type ActivationEvidence = z.infer<typeof activationEvidenceSchema>;
export type ActivationEvidenceMetrics = z.infer<typeof metricsSchema>;
export type PairedActivationEvidence = z.infer<
  typeof pairedActivationEvidenceSchema
>;
export type ClaimEligibility = z.infer<typeof claimEligibilitySchema>;

export class EvidenceValidationError extends Error {
  public constructor(readonly codes: readonly string[]) {
    super(codes.join(","));
    this.name = "EvidenceValidationError";
  }
}

export interface ActivationEvidenceReport {
  readonly evidenceId: string;
  readonly status: "complete" | "incomplete";
  readonly observationCount: number;
  readonly metrics: ActivationEvidenceMetrics;
  readonly diagnosticCodes: readonly EvidenceDiagnosticCode[];
}

export interface PairedActivationEvidenceReport {
  readonly evidencePairId: string;
  readonly status: "complete" | "incomplete";
  readonly serverOnly: ActivationEvidenceReport;
  readonly adapter: ActivationEvidenceReport;
  readonly claimEligibility: ClaimEligibility;
}

export function loadActivationEvidence(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function loadPairedActivationEvidence(path: string): unknown {
  return loadActivationEvidence(path);
}

export function computeInventorySha256(
  inventory: Omit<z.infer<typeof effectiveInventorySchema>, "inventorySha256">,
): string {
  return createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
}

export function recomputeActivationEvidenceMetrics(
  value: unknown,
  projectRoot: string,
): ActivationEvidenceMetrics {
  let evidence: ActivationEvidence;
  try {
    evidence = activationEvidenceSchema.parse(value);
  } catch {
    throw new EvidenceValidationError(["EVIDENCE_SCHEMA_INVALID"]);
  }
  const fixtures = validateActivationFixtures(
    loadActivationFixtures(projectRoot),
  );
  return recomputeMetrics(
    evidence,
    new Map(fixtures.corpus.cases.map((entry) => [entry.id, entry])),
  );
}

export function derivePairedClaimEligibility(
  value: unknown,
  projectRoot: string,
): ClaimEligibility {
  const pair = parsePairedEvidence(value);
  const fixtures = validateActivationFixtures(
    loadActivationFixtures(projectRoot),
  );
  return deriveClaimEligibility(pair, fixtures.corpus);
}

export function validatePairedActivationEvidence(
  value: unknown,
  projectRoot: string,
): PairedActivationEvidenceReport {
  const pair = parsePairedEvidence(value);
  const fixtures = validateActivationFixtures(
    loadActivationFixtures(projectRoot),
  );
  const fatalCodes = new Set<string>();

  validateHistoricalBaseline(pair, projectRoot, fatalCodes);
  validatePairControls(pair, fixtures.corpus, projectRoot, fatalCodes);

  let serverOnly: ActivationEvidenceReport;
  let adapter: ActivationEvidenceReport;
  try {
    serverOnly = validateActivationEvidence(pair.serverOnlyRun, projectRoot);
  } catch (error) {
    addNestedEvidenceCodes("SERVER_ONLY", error, fatalCodes);
    serverOnly = emptyEvidenceReport(pair.serverOnlyRun.evidenceId);
  }
  try {
    adapter = validateActivationEvidence(pair.adapterRun, projectRoot);
  } catch (error) {
    addNestedEvidenceCodes("ADAPTER", error, fatalCodes);
    adapter = emptyEvidenceReport(pair.adapterRun.evidenceId);
  }

  const claimEligibility = deriveClaimEligibility(pair, fixtures.corpus);
  if (
    JSON.stringify(pair.claimEligibility) !== JSON.stringify(claimEligibility)
  ) {
    fatalCodes.add("CLAIM_ELIGIBILITY_MISMATCH");
  }
  if (fatalCodes.size > 0) {
    throw new EvidenceValidationError([...fatalCodes].sort());
  }
  return {
    evidencePairId: pair.evidencePairId,
    status:
      serverOnly.status === "incomplete" || adapter.status === "incomplete"
        ? "incomplete"
        : "complete",
    serverOnly,
    adapter,
    claimEligibility,
  };
}

function parsePairedEvidence(value: unknown): PairedActivationEvidence {
  try {
    return pairedActivationEvidenceSchema.parse(value);
  } catch {
    throw new EvidenceValidationError(["PAIRED_EVIDENCE_SCHEMA_INVALID"]);
  }
}

function validateHistoricalBaseline(
  pair: PairedActivationEvidence,
  projectRoot: string,
  fatalCodes: Set<string>,
): void {
  const candidatePath = join(projectRoot, pair.preservedBaseline.path);
  let bytes: Buffer;
  try {
    bytes = readFileSync(candidatePath);
  } catch {
    fatalCodes.add("HISTORICAL_BASELINE_MISSING");
    return;
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pair.preservedBaseline.sha256) {
    fatalCodes.add("HISTORICAL_BASELINE_MISMATCH");
    return;
  }
  try {
    const report = validateActivationEvidence(
      JSON.parse(bytes.toString("utf8")) as unknown,
      projectRoot,
    );
    if (
      report.metrics.spontaneousActivation.numerator !==
        pair.preservedBaseline.completedSpontaneousActivations ||
      report.metrics.spontaneousActivation.denominator !==
        pair.preservedBaseline.relevantCases
    ) {
      fatalCodes.add("HISTORICAL_BASELINE_MISMATCH");
    }
  } catch {
    fatalCodes.add("HISTORICAL_BASELINE_MISMATCH");
  }
}

function validatePairControls(
  pair: PairedActivationEvidence,
  corpus: ActivationCorpus,
  projectRoot: string,
  fatalCodes: Set<string>,
): void {
  const experiment = pair.experiment;
  const serverOnly = pair.serverOnlyRun;
  const adapter = pair.adapterRun;
  const expectedCaseIds = experiment.caseIds;
  let releaseSubset:
    ReturnType<typeof validateActivationReleaseSubset> | undefined;
  try {
    releaseSubset = validateActivationReleaseSubset(projectRoot, corpus);
  } catch {
    fatalCodes.add("RELEASE_SUBSET_INVALID");
  }
  const releaseCaseIds = releaseSubset?.caseIds;
  if (
    releaseCaseIds === undefined ||
    JSON.stringify(expectedCaseIds) !== JSON.stringify(releaseCaseIds)
  ) {
    fatalCodes.add("RELEASE_SUBSET_MISMATCH");
  }
  const corpusById = new Map(corpus.cases.map((entry) => [entry.id, entry]));
  const selected = expectedCaseIds
    .map((caseId) => corpusById.get(caseId))
    .filter((entry): entry is ActivationCorpus["cases"][number] =>
      Boolean(entry),
    );
  if (selected.length !== expectedCaseIds.length) {
    fatalCodes.add("PAIR_CASE_UNKNOWN");
  }
  const counts = {
    relevant: selected.filter(
      (entry) =>
        entry.scenarioClass === "automatic-relevant" &&
        entry.localSkillFixture === undefined &&
        entry.failureMode === undefined,
    ).length,
    irrelevant: selected.filter(
      ({ scenarioClass }) => scenarioClass === "irrelevant",
    ).length,
    explicit: selected.filter(
      ({ scenarioClass }) => scenarioClass === "user-requested-explicit",
    ).length,
    withoutIntent: selected.filter(
      ({ scenarioClass }) => scenarioClass === "user-requested-without-intent",
    ).length,
  };
  if (
    counts.relevant !== 8 ||
    counts.irrelevant !== 3 ||
    counts.explicit !== 2 ||
    counts.withoutIntent !== 2 ||
    selected.some(({ localSkillFixture }) => localSkillFixture !== undefined)
  ) {
    fatalCodes.add("PAIR_COHORT_INVALID");
  }
  for (const pairId of new Set(
    selected
      .map(({ pairId }) => pairId)
      .filter((pairId): pairId is string => pairId !== undefined),
  )) {
    if (selected.filter((entry) => entry.pairId === pairId).length !== 2) {
      fatalCodes.add("PAIR_COHORT_INVALID");
    }
  }

  const serverIds = serverOnly.observations.map(({ caseId }) => caseId);
  const adapterIds = adapter.observations.map(({ caseId }) => caseId);
  if (
    JSON.stringify(serverIds) !== JSON.stringify(expectedCaseIds) ||
    JSON.stringify(adapterIds) !== JSON.stringify(expectedCaseIds)
  ) {
    fatalCodes.add("PAIR_CASE_MISMATCH");
  }

  const commonRunControls = (run: ActivationEvidence) => ({
    policyVersion: run.policyVersion,
    corpusId: run.corpusId,
    catalogRelease: run.catalogRelease,
    protocolVersion: run.protocolVersion,
    harness: run.harness,
    model: run.model,
    localInventoryVersion: run.localInventoryVersion,
    evaluatorVersion: run.evaluatorVersion,
    traceSource: run.traceSource,
    instructionsSha256: run.instructionsSha256,
    privacyDeclaration: run.privacyDeclaration,
  });
  if (
    JSON.stringify(commonRunControls(serverOnly)) !==
    JSON.stringify(commonRunControls(adapter))
  ) {
    fatalCodes.add("PAIR_CONTROL_MISMATCH");
  }
  if (
    experiment.skillWireCommit !== pair.adapter.sourceCommit ||
    experiment.codexCliVersion !== serverOnly.harness.version ||
    experiment.codexCliVersion !== adapter.harness.version ||
    JSON.stringify(experiment.model) !== JSON.stringify(serverOnly.model) ||
    experiment.catalogRelease !== serverOnly.catalogRelease ||
    experiment.protocolVersion !== serverOnly.protocolVersion ||
    experiment.evaluatorVersion !== serverOnly.evaluatorVersion
  ) {
    fatalCodes.add("EXPERIMENT_CONTROL_MISMATCH");
  }

  validateInventory(experiment.serverOnlyInventory, fatalCodes);
  validateInventory(experiment.adapterInventory, fatalCodes);
  const stripInventoryDifference = (
    inventory: typeof experiment.serverOnlyInventory,
  ) => ({
    platformBaselineSkills: inventory.platformBaselineSkills,
    userSkills: inventory.userSkills,
    repositorySkills: inventory.repositorySkills,
    adminSkills: inventory.adminSkills,
    mcpServers: inventory.mcpServers,
  });
  if (
    JSON.stringify(stripInventoryDifference(experiment.serverOnlyInventory)) !==
    JSON.stringify(stripInventoryDifference(experiment.adapterInventory))
  ) {
    fatalCodes.add("PAIR_INVENTORY_MISMATCH");
  }

  try {
    const integrity = validateCodexAdapterIntegrityManifest(
      JSON.parse(
        readFileSync(
          join(
            projectRoot,
            "distribution/codex-marketplace/release-integrity.json",
          ),
          "utf8",
        ),
      ) as unknown,
      join(projectRoot, "integrations/codex/skillwire-autonomous-activation"),
    );
    if (
      pair.adapter.pluginVersion !== integrity.pluginVersion ||
      pair.adapter.packageSha256 !== integrity.packageSha256 ||
      pair.adapter.dependencyUrlSha256 !==
        createHash("sha256").update(CANONICAL_SKILLWIRE_MCP_URL).digest("hex")
    ) {
      fatalCodes.add("ADAPTER_RELEASE_MISMATCH");
    }
  } catch {
    fatalCodes.add("ADAPTER_RELEASE_MISMATCH");
  }
}

function validateInventory(
  inventory: z.infer<typeof effectiveInventorySchema>,
  fatalCodes: Set<string>,
): void {
  const { inventorySha256, ...content } = inventory;
  if (computeInventorySha256(content) !== inventorySha256) {
    fatalCodes.add("INVENTORY_HASH_MISMATCH");
  }
}

function deriveClaimEligibility(
  pair: PairedActivationEvidence,
  corpus: ActivationCorpus,
): ClaimEligibility {
  const caseById = new Map(corpus.cases.map((entry) => [entry.id, entry]));
  const adapterMetrics = recomputeMetrics(pair.adapterRun, caseById);
  const diagnostics = new Set<z.infer<typeof claimDiagnosticCodeSchema>>();
  const evaluatedRelevantCases =
    adapterMetrics.spontaneousActivation.denominator;
  if (evaluatedRelevantCases < 8) {
    diagnostics.add("insufficient-relevant-cases");
  }
  if (adapterMetrics.spontaneousActivation.rate < 0.8) {
    diagnostics.add("spontaneous-activation-below-target");
  }
  if (adapterMetrics.correctSelectionAfterSearch.rate < 0.9) {
    diagnostics.add("correct-selection-below-target");
  }
  if (adapterMetrics.unnecessaryActivation.rate > 0.1) {
    diagnostics.add("unnecessary-activation-above-target");
  }
  if (
    adapterMetrics.userRequestedIsolation.denominator < 2 ||
    adapterMetrics.userRequestedIsolation.rate !== 1
  ) {
    diagnostics.add("user-requested-isolation-failed");
  }
  const explicitCases = pair.adapterRun.observations.filter(
    (observation) =>
      caseById.get(observation.caseId)?.scenarioClass ===
      "user-requested-explicit",
  );
  if (
    explicitCases.length < 2 ||
    explicitCases.some((observation) => {
      const activationCase = caseById.get(observation.caseId);
      const expected = activationCase?.expectedCatalogMatch;
      const searches = observation.toolCalls.filter(
        ({ toolName }) => toolName === "search_skills",
      );
      return (
        observation.status !== "completed" ||
        observation.completionEvidence === "none" ||
        expected === null ||
        expected === undefined ||
        searches.length !== 1 ||
        searches[0]?.invocationContext !== "user-requested" ||
        !sameIdentity(observation.verifiedSkillWireLoad, expected)
      );
    })
  ) {
    diagnostics.add("user-requested-isolation-failed");
  }
  if (!adapterMetrics.zeroClientWrites) {
    diagnostics.add("client-write-observed");
  }
  if (
    adapterMetrics.progressiveLoadingConformance.denominator > 0 &&
    adapterMetrics.progressiveLoadingConformance.rate !== 1
  ) {
    diagnostics.add("progressive-loading-conformance-failed");
  }
  if (
    pair.serverOnlyRun.observations.some(
      ({ status }) => status === "incomplete",
    ) ||
    pair.adapterRun.observations.some(({ status }) => status === "incomplete")
  ) {
    diagnostics.add("incomplete-observations");
  }

  for (const observation of pair.adapterRun.observations) {
    const activationCase = caseById.get(observation.caseId);
    if (
      activationCase?.scenarioClass !== "automatic-relevant" ||
      activationCase.localSkillFixture !== undefined ||
      activationCase.failureMode !== undefined
    ) {
      continue;
    }
    const searched = observation.toolCalls.some(
      ({ toolName }) => toolName === "search_skills",
    );
    if (searched && !hasAttributableWorkflow(observation, activationCase)) {
      diagnostics.add("unattributable-success-trace");
    }
  }
  return {
    eligible: diagnostics.size === 0,
    evaluatedRelevantCases,
    diagnosticCodes: [...diagnostics],
  };
}

function hasAttributableWorkflow(
  observation: ActivationEvidence["observations"][number],
  activationCase: ActivationCorpus["cases"][number],
): boolean {
  const expected = activationCase.expectedCatalogMatch;
  if (expected === null || !hasCompletedTaskEvidence(observation)) return false;
  const expectedSequence = activationCase.expectedBehavior.operationSequence;
  if (
    JSON.stringify(observation.toolCalls.map(({ toolName }) => toolName)) !==
      JSON.stringify(expectedSequence) ||
    observation.toolCalls.some(({ result }) => result !== "success") ||
    observation.toolCalls[0]?.invocationContext !== "automatic" ||
    !sameIdentity(observation.toolCalls[1]?.skill, expected) ||
    !sameIdentity(observation.verifiedSkillWireLoad, expected)
  ) {
    return false;
  }
  const resourcePaths = observation.toolCalls
    .filter(({ toolName }) => toolName === "read_skill_resource")
    .map(({ resourcePath }) => resourcePath);
  return (
    JSON.stringify(resourcePaths) ===
    JSON.stringify(activationCase.expectedBehavior.resourcePaths)
  );
}

function addNestedEvidenceCodes(
  prefix: string,
  error: unknown,
  fatalCodes: Set<string>,
): void {
  if (error instanceof EvidenceValidationError) {
    error.codes.forEach((code) => fatalCodes.add(`${prefix}_${code}`));
  } else {
    fatalCodes.add(`${prefix}_EVIDENCE_INVALID`);
  }
}

function emptyEvidenceReport(evidenceId: string): ActivationEvidenceReport {
  return {
    evidenceId,
    status: "incomplete",
    observationCount: 0,
    metrics: {
      spontaneousActivation: ratio(0, 0),
      correctSelectionAfterSearch: ratio(0, 0),
      unnecessaryActivation: ratio(0, 0),
      userRequestedIsolation: ratio(0, 0),
      progressiveLoadingConformance: ratio(0, 0),
      zeroClientWrites: false,
      zeroAgentFacingGithubRequests: false,
      localOverlap: { equivalentCases: 0, overlappingCases: 0, violations: 0 },
    },
    diagnosticCodes: [],
  };
}

export function validateActivationEvidence(
  value: unknown,
  projectRoot: string,
): ActivationEvidenceReport {
  let evidence: ActivationEvidence;
  try {
    evidence = activationEvidenceSchema.parse(value);
  } catch {
    throw new EvidenceValidationError(["EVIDENCE_SCHEMA_INVALID"]);
  }
  const fixtures = validateActivationFixtures(
    loadActivationFixtures(projectRoot),
  );
  const expectedInstructionsHash = createHash("sha256")
    .update(ACTIVATION_INSTRUCTIONS)
    .digest("hex");
  if (
    evidence.catalogRelease !== fixtures.corpus.catalogRelease ||
    evidence.localInventoryVersion !== fixtures.localInventory.inventoryId ||
    evidence.instructionsSha256 !== expectedInstructionsHash
  ) {
    throw new EvidenceValidationError(["VERSION_BINDING_MISMATCH"]);
  }

  const caseById = new Map(
    fixtures.corpus.cases.map((entry) => [entry.id, entry]),
  );
  const observationIds = new Set<string>();
  const allDiagnostics = new Set<EvidenceDiagnosticCode>();
  const fatalCodes = new Set<string>();
  for (const observation of evidence.observations) {
    const activationCase = caseById.get(observation.caseId);
    if (activationCase === undefined) {
      fatalCodes.add("UNKNOWN_CASE");
      continue;
    }
    if (observationIds.has(observation.caseId)) {
      fatalCodes.add("DUPLICATE_OBSERVATION");
    }
    observationIds.add(observation.caseId);
    const diagnostics = diagnoseObservation(
      observation,
      activationCase,
      evidence.protocolVersion,
    );
    diagnostics.forEach((code) => allDiagnostics.add(code));
    for (const code of diagnostics) {
      if (
        [
          "REPEATED_SEARCH",
          "REPEATED_LOAD",
          "WRONG_INVOCATION_CONTEXT",
          "LOAD_WITHOUT_PREVIEW",
          "RESOURCE_WITHOUT_LOAD",
          "DUPLICATE_RESOURCE",
          "EXPLICIT_LOCAL_OVERRIDE",
          "RETRY_AFTER_FAILURE",
          "UNATTRIBUTABLE_OUTCOME",
          "UNSUPPORTED_POSITIVE_OUTCOME",
          "CLIENT_TREE_WRITE",
          "AGENT_FACING_GITHUB_REQUEST",
        ].includes(code)
      ) {
        fatalCodes.add(code);
      }
    }
    const sequences = observation.toolCalls.map(({ sequence }) => sequence);
    if (
      new Set(sequences).size !== sequences.length ||
      sequences.some((sequence, index) => sequence !== index + 1)
    ) {
      fatalCodes.add("DUPLICATE_SEQUENCE");
    }
  }

  const metrics = recomputeMetrics(evidence, caseById);
  if (JSON.stringify(metrics) !== JSON.stringify(evidence.metrics)) {
    fatalCodes.add("METRICS_MISMATCH");
  }
  if (fatalCodes.size > 0) {
    throw new EvidenceValidationError([...fatalCodes].sort());
  }

  return {
    evidenceId: evidence.evidenceId,
    status: evidence.observations.some(({ status }) => status === "incomplete")
      ? "incomplete"
      : "complete",
    observationCount: evidence.observations.length,
    metrics,
    diagnosticCodes: [...allDiagnostics],
  };
}

function diagnoseObservation(
  observation: ActivationEvidence["observations"][number],
  activationCase: ActivationCorpus["cases"][number],
  protocolVersion: ActivationEvidence["protocolVersion"],
): EvidenceDiagnosticCode[] {
  const diagnostics = new Set<EvidenceDiagnosticCode>();
  const expectedMethod =
    protocolVersion === "2025-11-25" ? "initialize" : "server/discover";
  if (
    !observation.instructionsObserved ||
    observation.instructionMethod !== expectedMethod
  ) {
    diagnostics.add("INSTRUCTIONS_NOT_OBSERVED");
  }
  if (observation.status === "incomplete") diagnostics.add("INCOMPLETE_TRACE");
  if (observation.clientTreeWrites > 0) diagnostics.add("CLIENT_TREE_WRITE");
  if (observation.githubRequests > 0)
    diagnostics.add("AGENT_FACING_GITHUB_REQUEST");

  const searches = observation.toolCalls.filter(
    ({ toolName }) => toolName === "search_skills",
  );
  const loads = observation.toolCalls.filter(
    ({ toolName }) => toolName === "load_skill",
  );
  const resources = observation.toolCalls.filter(
    ({ toolName }) => toolName === "read_skill_resource",
  );
  if (
    searches.length === 0 &&
    activationCase.expectedBehavior.search === "call"
  )
    diagnostics.add("EXPECTED_SEARCH_MISSING");
  if (searches.length > 0 && activationCase.expectedBehavior.search === "skip")
    diagnostics.add("UNNECESSARY_SEARCH");
  if (searches.length > 1) diagnostics.add("REPEATED_SEARCH");
  if (
    searches.some(
      ({ invocationContext }) =>
        invocationContext !== activationCase.invocationContext,
    )
  ) {
    diagnostics.add("WRONG_INVOCATION_CONTEXT");
  }
  if (loads.length > 1) diagnostics.add("REPEATED_LOAD");
  if (loads.length > 0 && searches.length === 0)
    diagnostics.add("LOAD_WITHOUT_PREVIEW");
  if (resources.length > 0 && loads.length === 0)
    diagnostics.add("RESOURCE_WITHOUT_LOAD");

  const expectedIdentity = activationCase.expectedCatalogMatch;
  for (const load of loads) {
    if (
      load.result === "success" &&
      !sameIdentity(load.skill, expectedIdentity)
    ) {
      diagnostics.add("WRONG_SKILL");
    }
  }
  if (
    activationCase.scenarioClass === "user-requested-without-intent" &&
    observation.verifiedSkillWireLoad !== null
  ) {
    diagnostics.add("USER_ONLY_LEAK");
  }

  const loadedSuccessfully = loads.find(({ result }) => result === "success");
  if (
    observation.verifiedSkillWireLoad === null
      ? loadedSuccessfully !== undefined ||
        observation.guidanceSource === "skillwire" ||
        observation.guidanceSource === "local-and-skillwire"
      : loadedSuccessfully === undefined ||
        !sameIdentity(
          observation.verifiedSkillWireLoad,
          loadedSuccessfully.skill ?? null,
        )
  ) {
    diagnostics.add("UNATTRIBUTABLE_OUTCOME");
  }

  const resourcePaths = new Set<string>();
  for (const resource of resources) {
    if (resource.resourcePath === undefined) {
      diagnostics.add("UNDECLARED_RESOURCE");
      continue;
    }
    if (resourcePaths.has(resource.resourcePath))
      diagnostics.add("DUPLICATE_RESOURCE");
    resourcePaths.add(resource.resourcePath);
    if (
      !activationCase.expectedBehavior.resourcePaths.includes(
        resource.resourcePath,
      )
    )
      diagnostics.add("UNDECLARED_RESOURCE");
  }
  if (
    resources.length > activationCase.expectedBehavior.maxResourceCalls ||
    (resources.length > 0 &&
      activationCase.expectedBehavior.resourcePaths.length === 0)
  ) {
    diagnostics.add("UNNECESSARY_RESOURCE");
  }

  if (
    activationCase.localSkillFixture !== undefined &&
    observation.verifiedSkillWireLoad !== null
  ) {
    diagnostics.add("LOCAL_PRECEDENCE_VIOLATION");
    if (activationCase.localSkillFixture.explicitlySelected)
      diagnostics.add("EXPLICIT_LOCAL_OVERRIDE");
  }
  const firstError = observation.toolCalls.findIndex(
    ({ result }) => result === "error",
  );
  if (firstError >= 0 && firstError < observation.toolCalls.length - 1)
    diagnostics.add("RETRY_AFTER_FAILURE");

  if (
    observation.positiveOutcomeRecorded &&
    (observation.verifiedSkillWireLoad === null ||
      observation.completionEvidence === "none" ||
      observation.status !== "completed")
  ) {
    diagnostics.add("UNSUPPORTED_POSITIVE_OUTCOME");
  }
  return [...diagnostics];
}

function sameIdentity(
  left:
    | { skillId: string; revision: string; revisionSha256: string }
    | undefined
    | null,
  right:
    | { skillId: string; revision: string; revisionSha256: string }
    | undefined
    | null,
): boolean {
  if (!left || !right) return false;
  return (
    left.skillId === right.skillId &&
    left.revision === right.revision &&
    left.revisionSha256 === right.revisionSha256
  );
}

function hasCompletedTaskEvidence(
  observation: ActivationEvidence["observations"][number],
): boolean {
  return (
    observation.status === "completed" &&
    observation.completionEvidence !== "none"
  );
}

function recomputeMetrics(
  evidence: ActivationEvidence,
  caseById: ReadonlyMap<string, ActivationCorpus["cases"][number]>,
): ActivationEvidenceMetrics {
  const evaluated = evidence.observations.filter(
    ({ status }) => status !== "incomplete",
  );
  const searchCount = (observation: (typeof evaluated)[number]) =>
    observation.toolCalls.filter(({ toolName }) => toolName === "search_skills")
      .length;
  const cleanRelevant = evaluated.filter((observation) => {
    const activationCase = caseById.get(observation.caseId);
    return (
      activationCase?.scenarioClass === "automatic-relevant" &&
      activationCase.localSkillFixture === undefined &&
      activationCase.failureMode === undefined
    );
  });
  const searchedRelevant = evaluated.filter((observation) => {
    const activationCase = caseById.get(observation.caseId);
    return (
      searchCount(observation) > 0 &&
      activationCase?.expectedCatalogMatch !== null &&
      activationCase?.failureMode === undefined &&
      activationCase?.localSkillFixture === undefined
    );
  });
  const irrelevant = evaluated.filter(
    (observation) =>
      caseById.get(observation.caseId)?.scenarioClass === "irrelevant",
  );
  const withoutIntent = evaluated.filter(
    (observation) =>
      caseById.get(observation.caseId)?.scenarioClass ===
      "user-requested-without-intent",
  );
  const loaded = evaluated.filter(
    ({ verifiedSkillWireLoad }) => verifiedSkillWireLoad !== null,
  );
  const local = evaluated.filter(
    (observation) =>
      caseById.get(observation.caseId)?.localSkillFixture !== undefined,
  );

  return {
    spontaneousActivation: ratio(
      cleanRelevant.filter(
        (observation) =>
          hasCompletedTaskEvidence(observation) &&
          searchCount(observation) === 1,
      ).length,
      cleanRelevant.length,
    ),
    correctSelectionAfterSearch: ratio(
      searchedRelevant.filter((observation) => {
        const expected = caseById.get(observation.caseId)?.expectedCatalogMatch;
        return (
          hasCompletedTaskEvidence(observation) &&
          sameIdentity(observation.verifiedSkillWireLoad, expected)
        );
      }).length,
      searchedRelevant.length,
    ),
    unnecessaryActivation: ratio(
      irrelevant.filter((observation) => searchCount(observation) > 0).length,
      irrelevant.length,
    ),
    userRequestedIsolation: ratio(
      withoutIntent.filter(
        ({ verifiedSkillWireLoad }) => verifiedSkillWireLoad === null,
      ).length,
      withoutIntent.length,
    ),
    progressiveLoadingConformance: ratio(
      loaded.filter((observation) => {
        const activationCase = caseById.get(observation.caseId);
        const resourcePaths = observation.toolCalls
          .filter(({ toolName }) => toolName === "read_skill_resource")
          .map(({ resourcePath }) => resourcePath);
        return (
          hasCompletedTaskEvidence(observation) &&
          searchCount(observation) === 1 &&
          observation.toolCalls.filter(
            ({ toolName }) => toolName === "load_skill",
          ).length === 1 &&
          resourcePaths.length === new Set(resourcePaths).size &&
          resourcePaths.every((path) =>
            path === undefined
              ? false
              : activationCase?.expectedBehavior.resourcePaths.includes(path),
          ) &&
          (activationCase?.expectedBehavior.resourcePaths.length ?? 0) ===
            resourcePaths.length
        );
      }).length,
      loaded.length,
    ),
    zeroClientWrites: evidence.observations.every(
      ({ clientTreeWrites }) => clientTreeWrites === 0,
    ),
    zeroAgentFacingGithubRequests: evidence.observations.every(
      ({ githubRequests }) => githubRequests === 0,
    ),
    localOverlap: {
      equivalentCases: local.filter(
        (observation) =>
          caseById.get(observation.caseId)?.localSkillFixture?.relationship ===
          "equivalent",
      ).length,
      overlappingCases: local.filter(
        (observation) =>
          caseById.get(observation.caseId)?.localSkillFixture?.relationship ===
          "overlapping",
      ).length,
      violations: local.filter(
        ({ verifiedSkillWireLoad }) => verifiedSkillWireLoad !== null,
      ).length,
    },
  };
}

function ratio(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? 0 : numerator / denominator,
  };
}
