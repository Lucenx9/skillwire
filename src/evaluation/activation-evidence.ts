import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";

import { ACTIVATION_INSTRUCTIONS } from "../transport/mcp/activation-policy.js";
import {
  loadActivationFixtures,
  validateActivationFixtures,
  type ActivationCorpus,
} from "./activation-corpus-runner.js";

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

export type ActivationEvidence = z.infer<typeof activationEvidenceSchema>;
export type ActivationEvidenceMetrics = z.infer<typeof metricsSchema>;

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

export function loadActivationEvidence(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
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
          "UNDECLARED_RESOURCE",
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

function recomputeMetrics(
  evidence: ActivationEvidence,
  caseById: ReadonlyMap<string, ActivationCorpus["cases"][number]>,
): ActivationEvidenceMetrics {
  const completed = evidence.observations.filter(
    ({ status }) => status !== "incomplete",
  );
  const searchCount = (observation: (typeof completed)[number]) =>
    observation.toolCalls.filter(({ toolName }) => toolName === "search_skills")
      .length;
  const cleanRelevant = completed.filter((observation) => {
    const activationCase = caseById.get(observation.caseId);
    return (
      activationCase?.scenarioClass === "automatic-relevant" &&
      activationCase.localSkillFixture === undefined &&
      activationCase.failureMode === undefined
    );
  });
  const searchedRelevant = completed.filter((observation) => {
    const activationCase = caseById.get(observation.caseId);
    return (
      searchCount(observation) > 0 &&
      activationCase?.expectedCatalogMatch !== null &&
      activationCase?.failureMode === undefined &&
      activationCase?.localSkillFixture === undefined
    );
  });
  const irrelevant = completed.filter(
    (observation) =>
      caseById.get(observation.caseId)?.scenarioClass === "irrelevant",
  );
  const withoutIntent = completed.filter(
    (observation) =>
      caseById.get(observation.caseId)?.scenarioClass ===
      "user-requested-without-intent",
  );
  const loaded = completed.filter(
    ({ verifiedSkillWireLoad }) => verifiedSkillWireLoad !== null,
  );
  const local = completed.filter(
    (observation) =>
      caseById.get(observation.caseId)?.localSkillFixture !== undefined,
  );

  return {
    spontaneousActivation: ratio(
      cleanRelevant.filter((observation) => searchCount(observation) === 1)
        .length,
      cleanRelevant.length,
    ),
    correctSelectionAfterSearch: ratio(
      searchedRelevant.filter((observation) => {
        const expected = caseById.get(observation.caseId)?.expectedCatalogMatch;
        return sameIdentity(observation.verifiedSkillWireLoad, expected);
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
