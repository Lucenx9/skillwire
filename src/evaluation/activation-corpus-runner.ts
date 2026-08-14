import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { rankSkills } from "../domain/catalog/ranking.js";
import type { CatalogSkillMetadata } from "../domain/catalog/types.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FIXTURE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
// eslint-disable-next-line no-control-regex -- the frozen contract rejects NUL.
const RESOURCE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000]+$/;
const PRIVATE_PROMPT_PATTERN =
  /(?:api[_-]?key|authorization:|bearer\s+|-----BEGIN|\/home\/|[A-Z]:\\)/i;

const skillIdentitySchema = z
  .object({
    skillId: z.string().min(1).max(256),
    revision: z.string().min(1).max(256),
    revisionSha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

const localSkillFixtureSchema = z
  .object({
    fixtureId: z.string().min(1).max(128).regex(FIXTURE_ID_PATTERN),
    relationship: z.enum(["equivalent", "overlapping"]),
    explicitlySelected: z.boolean(),
  })
  .strict();

const operationSchema = z.enum([
  "search_skills",
  "load_skill",
  "read_skill_resource",
]);

const expectedBehaviorSchema = z
  .object({
    search: z.enum(["call", "skip"]),
    load: z.enum(["call", "skip"]),
    operationSequence: z.array(operationSchema).max(7),
    maxSearchCalls: z.number().int().min(0).max(1),
    maxLoadCalls: z.number().int().min(0).max(1),
    maxResourceCalls: z.number().int().min(0).max(5),
    resourcePaths: z
      .array(z.string().min(1).max(1024).regex(RESOURCE_PATH_PATTERN))
      .max(5),
    repositoryHashProvided: z.boolean(),
    expectedMemoryWrites: z.number().int().min(0).max(1),
    expectedOutcomeWrites: z.number().int().min(0).max(1),
    terminalReason: z.enum([
      "not-applicable",
      "local-precedence",
      "no-result",
      "user-only-isolated",
      "instructions-sufficient",
      "resource-consumed",
      "service-unavailable",
      "authentication-failed",
      "rate-limited",
      "revision-unavailable",
      "resource-failed",
    ]),
  })
  .strict();

const activationCaseSchema = z
  .object({
    id: z.string().min(1).max(128).regex(ID_PATTERN),
    pairId: z.string().min(1).max(128).regex(ID_PATTERN).optional(),
    scenarioClass: z.enum([
      "automatic-relevant",
      "irrelevant",
      "user-requested-explicit",
      "user-requested-without-intent",
    ]),
    prompt: z.string().min(1).max(4096),
    explicitUserIntent: z.boolean(),
    invocationContext: z.enum(["automatic", "user-requested"]),
    localSkillFixture: localSkillFixtureSchema.optional(),
    expectedCatalogMatch: skillIdentitySchema.nullable(),
    expectedBehavior: expectedBehaviorSchema,
    failureMode: z
      .enum([
        "service-unavailable",
        "authentication-failed",
        "rate-limited",
        "no-relevant-result",
        "revision-unavailable",
        "resource-failed",
      ])
      .optional(),
    rationale: z.string().min(1).max(512),
  })
  .strict()
  .superRefine((value, context) => {
    const requireMatch = () => {
      if (value.expectedCatalogMatch === null) {
        context.addIssue({
          code: "custom",
          message: `${value.scenarioClass} requires an exact catalog match`,
        });
      }
    };
    const requireNoMatch = () => {
      if (value.expectedCatalogMatch !== null) {
        context.addIssue({
          code: "custom",
          message: `${value.scenarioClass} must not expose a catalog match`,
        });
      }
    };

    switch (value.scenarioClass) {
      case "automatic-relevant":
        requireMatch();
        if (
          value.explicitUserIntent ||
          value.invocationContext !== "automatic"
        ) {
          context.addIssue({
            code: "custom",
            message:
              "automatic cases require automatic context without explicit intent",
          });
        }
        break;
      case "irrelevant":
        requireNoMatch();
        if (
          value.explicitUserIntent ||
          value.invocationContext !== "automatic"
        ) {
          context.addIssue({
            code: "custom",
            message:
              "irrelevant cases require automatic context without explicit intent",
          });
        }
        break;
      case "user-requested-explicit":
        requireMatch();
        if (
          !value.pairId ||
          !value.explicitUserIntent ||
          value.invocationContext !== "user-requested"
        ) {
          context.addIssue({
            code: "custom",
            message: "explicit cases require a pair and user-requested context",
          });
        }
        break;
      case "user-requested-without-intent":
        requireNoMatch();
        if (
          !value.pairId ||
          value.explicitUserIntent ||
          value.invocationContext !== "automatic"
        ) {
          context.addIssue({
            code: "custom",
            message: "no-intent cases require a pair and automatic context",
          });
        }
        break;
    }
  });

const corpusSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpusId: z.literal("autonomous-activation-v1"),
    policyVersion: z.literal("skillwire-activation-v1"),
    catalogRelease: z.string().min(1).max(128).regex(FIXTURE_ID_PATTERN),
    localInventoryVersion: z.string().min(1).max(128).regex(FIXTURE_ID_PATTERN),
    cases: z.array(activationCaseSchema).min(60),
  })
  .strict();

const catalogSkillSchema = z
  .object({
    skillId: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    description: z.string().min(1).max(2048),
    capabilities: z.array(z.string().min(1).max(256)).min(1),
    revision: z.string().min(1).max(256),
    revisionSha256: z.string().regex(SHA256_PATTERN),
    invocationMode: z.enum(["automatic", "user-only"]),
    resourcePaths: z
      .array(z.string().min(1).max(1024).regex(RESOURCE_PATH_PATTERN))
      .max(64),
  })
  .strict();

const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    fixtureId: z.literal("activation-catalog-v1"),
    sourceRelease: z.string().min(1).max(128).regex(FIXTURE_ID_PATTERN),
    importedFixtureCommit: z.string().regex(/^[0-9a-f]{40}$/),
    skills: z.array(catalogSkillSchema).min(1),
  })
  .strict();

const localInventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    inventoryId: z.literal("activation-local-v1"),
    entries: z
      .array(
        z
          .object({
            caseId: z.string().min(1).max(128).regex(ID_PATTERN),
            fixtureId: z.string().min(1).max(128).regex(FIXTURE_ID_PATTERN),
            relationship: z.enum(["equivalent", "overlapping"]),
            explicitlySelected: z.boolean(),
            remoteSkillId: z.string().min(1).max(256),
          })
          .strict(),
      )
      .min(5),
  })
  .strict();

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifestId: z.literal("activation-fixtures-v1"),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            sha256: z.string().regex(SHA256_PATTERN),
          })
          .strict(),
      )
      .length(3),
  })
  .strict();

export type ActivationCorpus = z.infer<typeof corpusSchema>;
export type ActivationCatalog = z.infer<typeof catalogSchema>;
export type ActivationLocalInventory = z.infer<typeof localInventorySchema>;
export type ActivationFixtureManifest = z.infer<typeof manifestSchema>;

export interface ActivationFixtureFiles {
  corpus: unknown;
  catalog: unknown;
  localInventory: unknown;
  manifest: unknown;
  sourceText: Map<string, string>;
}

export interface ValidatedActivationFixtures {
  corpus: ActivationCorpus;
  catalog: ActivationCatalog;
  localInventory: ActivationLocalInventory;
  manifest: ActivationFixtureManifest;
  pairIds: readonly string[];
  cohortCounts: {
    automaticRelevant: number;
    irrelevant: number;
    userRequestedExplicit: number;
    userRequestedWithoutIntent: number;
    localOverlap: number;
  };
}

const activationTraceEventSchema = z
  .object({
    taskIntent: z.string().min(1).max(128),
    toolName: operationSchema,
    result: z.enum(["success", "empty", "error"]),
    invocationContext: z.enum(["automatic", "user-requested"]).optional(),
    summaryFingerprint: z.string().regex(SHA256_PATTERN).optional(),
    skillId: z.string().min(1).max(256).optional(),
    revision: z.string().min(1).max(256).optional(),
    path: z.string().min(1).max(1024).regex(RESOURCE_PATH_PATTERN).optional(),
  })
  .strict();

export type ActivationTraceEvent = z.infer<typeof activationTraceEventSchema>;

export type ActivationTraceReasonCode =
  | "REPEATED_SEARCH"
  | "CALL_AFTER_TERMINAL"
  | "CONTEXT_ESCALATION"
  | "SECOND_LOAD"
  | "LOAD_WITHOUT_SEARCH"
  | "RESOURCE_BEFORE_LOAD"
  | "DUPLICATE_RESOURCE";

export interface ActivationTraceValidation {
  readonly valid: boolean;
  readonly reasonCodes: readonly ActivationTraceReasonCode[];
}

interface ActivationEvaluationCase {
  readonly caseId: string;
  readonly topSkillId?: string | undefined;
  readonly expectedSkillId?: string | undefined;
  readonly matchValid: boolean;
  readonly traceValid: boolean;
  readonly failureMode?: string | undefined;
}

interface ActivationEvaluationCohort {
  readonly caseIds: readonly string[];
}

export interface ActivationEvaluationResult {
  readonly caseCount: number;
  readonly cases: readonly ActivationEvaluationCase[];
  readonly catalogMatchFailures: readonly string[];
  readonly traceExpectationFailures: readonly string[];
  readonly userRequestedIsolation: RateMetric;
  readonly zeroMatch: RateMetric;
  readonly progressiveResourceCases: number;
  readonly failureCounts: Readonly<Record<string, number>>;
  readonly cohorts: {
    readonly cleanAutomatic: ActivationEvaluationCohort;
    readonly localOverlap: ActivationEvaluationCohort;
    readonly failure: ActivationEvaluationCohort;
    readonly irrelevant: ActivationEvaluationCohort;
    readonly userRequestedExplicit: ActivationEvaluationCohort;
    readonly userRequestedWithoutIntent: ActivationEvaluationCohort;
  };
}

interface RateMetric {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
}

const CORPUS_PATH = "evaluation/autonomous-activation.v1.json";
const CATALOG_PATH = "tests/fixtures/activation/catalog.v1.json";
const LOCAL_INVENTORY_PATH =
  "tests/fixtures/activation/local-inventory.v1.json";
const MANIFEST_PATH = "tests/fixtures/activation/manifest.v1.json";

export function loadActivationFixtures(
  projectRoot: string,
): ActivationFixtureFiles {
  const read = (path: string) => readFileSync(join(projectRoot, path), "utf8");
  const sourceText = new Map([
    [CORPUS_PATH, read(CORPUS_PATH)],
    [CATALOG_PATH, read(CATALOG_PATH)],
    [LOCAL_INVENTORY_PATH, read(LOCAL_INVENTORY_PATH)],
  ]);

  return {
    corpus: JSON.parse(sourceText.get(CORPUS_PATH) ?? "null") as unknown,
    catalog: JSON.parse(sourceText.get(CATALOG_PATH) ?? "null") as unknown,
    localInventory: JSON.parse(
      sourceText.get(LOCAL_INVENTORY_PATH) ?? "null",
    ) as unknown,
    manifest: JSON.parse(read(MANIFEST_PATH)) as unknown,
    sourceText,
  };
}

export function validateActivationFixtures(
  fixtures: ActivationFixtureFiles,
): ValidatedActivationFixtures {
  const manifest = manifestSchema.parse(fixtures.manifest);
  const manifestPaths = new Set<string>();
  for (const entry of manifest.files) {
    if (manifestPaths.has(entry.path)) {
      throw new Error("Activation fixture manifest paths must be unique");
    }
    manifestPaths.add(entry.path);
    const text = fixtures.sourceText.get(entry.path);
    if (text === undefined) {
      throw new Error(
        `Activation fixture manifest path is missing: ${entry.path}`,
      );
    }
    const actual = createHash("sha256").update(text).digest("hex");
    if (actual !== entry.sha256) {
      throw new Error(`Activation fixture checksum mismatch: ${entry.path}`);
    }
  }
  if (
    manifestPaths.size !== 3 ||
    !manifestPaths.has(CORPUS_PATH) ||
    !manifestPaths.has(CATALOG_PATH) ||
    !manifestPaths.has(LOCAL_INVENTORY_PATH)
  ) {
    throw new Error(
      "Activation fixture manifest must enumerate the frozen inputs",
    );
  }

  const corpus = corpusSchema.parse(fixtures.corpus);
  const catalog = catalogSchema.parse(fixtures.catalog);
  const localInventory = localInventorySchema.parse(fixtures.localInventory);
  if (corpus.catalogRelease !== catalog.fixtureId) {
    throw new Error(
      "Activation corpus catalog release does not match its fixture",
    );
  }
  if (corpus.localInventoryVersion !== localInventory.inventoryId) {
    throw new Error("Activation corpus local inventory version does not match");
  }

  const caseIds = new Set<string>();
  const catalogByIdentity = new Map<
    string,
    ActivationCatalog["skills"][number]
  >();
  for (const skill of catalog.skills) {
    const key = identityKey(skill);
    if (catalogByIdentity.has(key)) {
      throw new Error("Activation catalog identities must be unique");
    }
    if (new Set(skill.resourcePaths).size !== skill.resourcePaths.length) {
      throw new Error("Activation catalog resource paths must be unique");
    }
    catalogByIdentity.set(key, skill);
  }

  const pairMembers = new Map<string, ActivationCorpus["cases"]>();
  const counts = {
    automaticRelevant: 0,
    irrelevant: 0,
    userRequestedExplicit: 0,
    userRequestedWithoutIntent: 0,
    localOverlap: 0,
  };
  for (const activationCase of corpus.cases) {
    if (caseIds.has(activationCase.id)) {
      throw new Error("Activation case identifiers must be unique");
    }
    caseIds.add(activationCase.id);
    if (PRIVATE_PROMPT_PATTERN.test(activationCase.prompt)) {
      throw new Error(
        `Activation prompt is not privacy-safe: ${activationCase.id}`,
      );
    }
    if (
      new Set(activationCase.expectedBehavior.resourcePaths).size !==
      activationCase.expectedBehavior.resourcePaths.length
    ) {
      throw new Error(
        `Activation resource paths must be unique: ${activationCase.id}`,
      );
    }
    assertExpectedOperationSequence(activationCase);

    switch (activationCase.scenarioClass) {
      case "automatic-relevant":
        counts.automaticRelevant += 1;
        break;
      case "irrelevant":
        counts.irrelevant += 1;
        break;
      case "user-requested-explicit":
        counts.userRequestedExplicit += 1;
        break;
      case "user-requested-without-intent":
        counts.userRequestedWithoutIntent += 1;
        break;
    }

    if (activationCase.expectedCatalogMatch !== null) {
      const catalogSkill = catalogByIdentity.get(
        identityKey(activationCase.expectedCatalogMatch),
      );
      if (catalogSkill === undefined) {
        throw new Error(
          `Activation case references an unknown exact catalog identity: ${activationCase.id}`,
        );
      }
      if (
        activationCase.scenarioClass === "automatic-relevant" &&
        catalogSkill.invocationMode !== "automatic"
      ) {
        throw new Error(
          `Automatic activation case references a user-only skill: ${activationCase.id}`,
        );
      }
      for (const resourcePath of activationCase.expectedBehavior
        .resourcePaths) {
        if (!catalogSkill.resourcePaths.includes(resourcePath)) {
          throw new Error(
            `Activation case references an undeclared resource: ${activationCase.id}`,
          );
        }
      }
    }

    if (activationCase.pairId !== undefined) {
      const members = pairMembers.get(activationCase.pairId) ?? [];
      members.push(activationCase);
      pairMembers.set(activationCase.pairId, members);
    }
    if (activationCase.localSkillFixture !== undefined) {
      counts.localOverlap += 1;
    }
  }

  if (
    counts.automaticRelevant < 25 ||
    counts.irrelevant < 15 ||
    counts.userRequestedExplicit < 10 ||
    counts.userRequestedWithoutIntent < 10 ||
    counts.localOverlap < 5
  ) {
    throw new Error("Activation corpus does not meet required cohort minima");
  }
  for (const [pairId, members] of pairMembers) {
    const memberClasses = members
      .map(({ scenarioClass }) => scenarioClass)
      .sort();
    if (
      members.length !== 2 ||
      memberClasses[0] !== "user-requested-explicit" ||
      memberClasses[1] !== "user-requested-without-intent"
    ) {
      throw new Error(`Activation pair is incomplete or invalid: ${pairId}`);
    }
  }
  if (pairMembers.size < 10) {
    throw new Error("Activation corpus requires ten explicit/no-intent pairs");
  }

  const localByCaseId = new Map(
    localInventory.entries.map((entry) => [entry.caseId, entry]),
  );
  if (localByCaseId.size !== localInventory.entries.length) {
    throw new Error("Local overlap case identifiers must be unique");
  }
  for (const activationCase of corpus.cases) {
    const localFixture = activationCase.localSkillFixture;
    const localEntry = localByCaseId.get(activationCase.id);
    if (localFixture === undefined && localEntry === undefined) {
      continue;
    }
    if (localFixture === undefined || localEntry === undefined) {
      throw new Error(
        `Local overlap declaration mismatch: ${activationCase.id}`,
      );
    }
    if (
      localEntry.fixtureId !== localFixture.fixtureId ||
      localEntry.relationship !== localFixture.relationship ||
      localEntry.explicitlySelected !== localFixture.explicitlySelected ||
      localEntry.remoteSkillId !== activationCase.expectedCatalogMatch?.skillId
    ) {
      throw new Error(
        `Local overlap declaration mismatch: ${activationCase.id}`,
      );
    }
  }
  if (
    corpus.cases.filter(
      ({ localSkillFixture }) => localSkillFixture !== undefined,
    ).length !== localInventory.entries.length
  ) {
    throw new Error(
      "Every local overlap inventory entry must resolve exactly once",
    );
  }

  return {
    corpus,
    catalog,
    localInventory,
    manifest,
    pairIds: [...pairMembers.keys()].sort(),
    cohortCounts: counts,
  };
}

export function validateActivationTrace(
  value: unknown,
): ActivationTraceValidation {
  const events = z.array(activationTraceEventSchema).max(100).parse(value);
  const reasonCodes = new Set<ActivationTraceReasonCode>();
  const attempts = new Map<
    string,
    {
      searchCount: number;
      loadCount: number;
      loaded: boolean;
      terminal: boolean;
      context?: "automatic" | "user-requested";
      resourcePaths: Set<string>;
    }
  >();

  for (const event of events) {
    const attempt = attempts.get(event.taskIntent) ?? {
      searchCount: 0,
      loadCount: 0,
      loaded: false,
      terminal: false,
      resourcePaths: new Set<string>(),
    };
    attempts.set(event.taskIntent, attempt);

    if (attempt.terminal) {
      reasonCodes.add("CALL_AFTER_TERMINAL");
    }
    if (
      attempt.context === "automatic" &&
      event.invocationContext === "user-requested"
    ) {
      reasonCodes.add("CONTEXT_ESCALATION");
    }
    if (event.invocationContext !== undefined) {
      attempt.context ??= event.invocationContext;
    }

    switch (event.toolName) {
      case "search_skills":
        if (attempt.searchCount > 0) {
          reasonCodes.add("REPEATED_SEARCH");
        }
        attempt.searchCount += 1;
        break;
      case "load_skill":
        if (attempt.searchCount === 0) {
          reasonCodes.add("LOAD_WITHOUT_SEARCH");
        }
        if (attempt.loadCount > 0) {
          reasonCodes.add("SECOND_LOAD");
        }
        attempt.loadCount += 1;
        if (event.result === "success") {
          attempt.loaded = true;
        }
        break;
      case "read_skill_resource":
        if (!attempt.loaded) {
          reasonCodes.add("RESOURCE_BEFORE_LOAD");
        }
        if (event.path !== undefined && attempt.resourcePaths.has(event.path)) {
          reasonCodes.add("DUPLICATE_RESOURCE");
        }
        if (event.path !== undefined) {
          attempt.resourcePaths.add(event.path);
        }
        break;
    }

    if (event.result === "empty" || event.result === "error") {
      attempt.terminal = true;
    }
  }

  return {
    valid: reasonCodes.size === 0,
    reasonCodes: [...reasonCodes],
  };
}

export function evaluateActivationCorpus(
  fixtures: ValidatedActivationFixtures,
): ActivationEvaluationResult {
  const metadata = fixtures.catalog.skills.map(
    (skill): CatalogSkillMetadata => ({
      id: skill.skillId,
      name: skill.name,
      description: skill.description,
      capabilities: skill.capabilities,
      revision: skill.revision,
      trustAtPublication:
        skill.invocationMode === "user-only"
          ? "structurally-verified"
          : "trusted",
      currentAdvisoryStatus: "available",
      ...(skill.invocationMode === "automatic"
        ? {}
        : { invocationMode: skill.invocationMode }),
    }),
  );
  const caseResults: ActivationEvaluationCase[] = [];
  const cohorts = {
    cleanAutomatic: { caseIds: [] as string[] },
    localOverlap: { caseIds: [] as string[] },
    failure: { caseIds: [] as string[] },
    irrelevant: { caseIds: [] as string[] },
    userRequestedExplicit: { caseIds: [] as string[] },
    userRequestedWithoutIntent: { caseIds: [] as string[] },
  };
  const failureCounts: Record<string, number> = {};
  let isolationNumerator = 0;
  let isolationDenominator = 0;
  let zeroMatchNumerator = 0;
  let zeroMatchDenominator = 0;
  let progressiveResourceCases = 0;

  for (const activationCase of fixtures.corpus.cases) {
    const eligible = metadata.filter(
      (skill) =>
        activationCase.invocationContext === "user-requested" ||
        skill.invocationMode !== "user-only",
    );
    const ranked = rankSkills(eligible, activationCase.prompt, 10);
    const topSkillId = ranked[0]?.skill.id;
    const expectedSkillId = activationCase.expectedCatalogMatch?.skillId;
    const relevantExpected =
      expectedSkillId === undefined ||
      ranked.some(({ skill }) => skill.id === expectedSkillId);
    const isolated =
      activationCase.scenarioClass !== "user-requested-without-intent" ||
      !ranked.some(({ skill }) => skill.invocationMode === "user-only");
    const zeroMatch =
      activationCase.scenarioClass !== "irrelevant" || ranked.length === 0;
    const matchValid = relevantExpected && isolated && zeroMatch;

    const expectedEvents: ActivationTraceEvent[] =
      activationCase.expectedBehavior.operationSequence.map(
        (toolName): ActivationTraceEvent => ({
          taskIntent: activationCase.id,
          toolName,
          result:
            toolName === "search_skills" &&
            activationCase.expectedBehavior.terminalReason === "no-result"
              ? "empty"
              : activationCase.failureMode !== undefined &&
                  toolName ===
                    activationCase.expectedBehavior.operationSequence.at(-1)
                ? "error"
                : "success",
          ...(toolName === "search_skills"
            ? { invocationContext: activationCase.invocationContext }
            : {}),
          ...(toolName === "load_skill" && expectedSkillId !== undefined
            ? {
                skillId: expectedSkillId,
                revision: activationCase.expectedCatalogMatch?.revision,
              }
            : {}),
          ...(toolName === "read_skill_resource"
            ? {
                path: activationCase.expectedBehavior.resourcePaths[
                  activationCase.expectedBehavior.operationSequence
                    .slice(
                      0,
                      activationCase.expectedBehavior.operationSequence.indexOf(
                        toolName,
                      ),
                    )
                    .filter((operation) => operation === "read_skill_resource")
                    .length
                ],
              }
            : {}),
        }),
      );
    const traceValid = validateActivationTrace(expectedEvents).valid;
    caseResults.push({
      caseId: activationCase.id,
      topSkillId,
      expectedSkillId,
      matchValid,
      traceValid,
      ...(activationCase.failureMode === undefined
        ? {}
        : { failureMode: activationCase.failureMode }),
    });

    if (activationCase.localSkillFixture !== undefined) {
      cohorts.localOverlap.caseIds.push(activationCase.id);
    } else if (
      activationCase.scenarioClass === "automatic-relevant" &&
      activationCase.failureMode !== undefined
    ) {
      cohorts.failure.caseIds.push(activationCase.id);
    } else if (activationCase.scenarioClass === "automatic-relevant") {
      cohorts.cleanAutomatic.caseIds.push(activationCase.id);
    }
    if (activationCase.scenarioClass === "irrelevant") {
      cohorts.irrelevant.caseIds.push(activationCase.id);
      zeroMatchDenominator += 1;
      if (ranked.length === 0) {
        zeroMatchNumerator += 1;
      }
    }
    if (activationCase.scenarioClass === "user-requested-explicit") {
      cohorts.userRequestedExplicit.caseIds.push(activationCase.id);
    }
    if (activationCase.scenarioClass === "user-requested-without-intent") {
      cohorts.userRequestedWithoutIntent.caseIds.push(activationCase.id);
      isolationDenominator += 1;
      if (isolated) isolationNumerator += 1;
    }
    if (activationCase.expectedBehavior.resourcePaths.length > 0) {
      progressiveResourceCases += 1;
    }
    if (activationCase.failureMode !== undefined) {
      failureCounts[activationCase.failureMode] =
        (failureCounts[activationCase.failureMode] ?? 0) + 1;
    }
  }

  return {
    caseCount: caseResults.length,
    cases: caseResults,
    catalogMatchFailures: caseResults
      .filter(({ matchValid }) => !matchValid)
      .map(({ caseId }) => caseId),
    traceExpectationFailures: caseResults
      .filter(({ traceValid }) => !traceValid)
      .map(({ caseId }) => caseId),
    userRequestedIsolation: rateMetric(
      isolationNumerator,
      isolationDenominator,
    ),
    zeroMatch: rateMetric(zeroMatchNumerator, zeroMatchDenominator),
    progressiveResourceCases,
    failureCounts,
    cohorts,
  };
}

function rateMetric(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? 0 : numerator / denominator,
  };
}

function identityKey(value: {
  skillId: string;
  revision: string;
  revisionSha256: string;
}): string {
  return `${value.skillId}\u0000${value.revision}\u0000${value.revisionSha256}`;
}

function assertExpectedOperationSequence(
  activationCase: ActivationCorpus["cases"][number],
): void {
  const behavior = activationCase.expectedBehavior;
  const expected: (typeof behavior.operationSequence)[number][] = [];
  if (behavior.search === "call") {
    expected.push("search_skills");
  }
  if (behavior.load === "call") {
    expected.push("load_skill");
  }
  for (const _resourcePath of behavior.resourcePaths) {
    expected.push("read_skill_resource");
  }
  if (
    expected.length !== behavior.operationSequence.length ||
    expected.some(
      (operation, index) => operation !== behavior.operationSequence[index],
    )
  ) {
    throw new Error(
      `Activation operation sequence is inconsistent: ${activationCase.id}`,
    );
  }
  const searchCount = behavior.operationSequence.filter(
    (operation) => operation === "search_skills",
  ).length;
  const loadCount = behavior.operationSequence.filter(
    (operation) => operation === "load_skill",
  ).length;
  const resourceCount = behavior.operationSequence.filter(
    (operation) => operation === "read_skill_resource",
  ).length;
  if (
    searchCount > behavior.maxSearchCalls ||
    loadCount > behavior.maxLoadCalls ||
    resourceCount > behavior.maxResourceCalls
  ) {
    throw new Error(
      `Activation operation bounds are inconsistent: ${activationCase.id}`,
    );
  }
}
