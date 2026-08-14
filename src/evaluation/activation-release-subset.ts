import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { ActivationCorpus } from "./activation-corpus-runner.js";

export const ACTIVATION_RELEASE_SUBSET_ID =
  "activation-release-candidate-pilot-v1" as const;
export const ACTIVATION_RELEASE_SUBSET_PATH =
  "evaluation/autonomous-activation-release-subset.v1.json" as const;
export const ACTIVATION_CORPUS_SHA256 =
  "a06e1ced82026bf007e0f1d9ee53c0a57c526cf59784285098a2840cb13e8b28" as const;

const caseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const releaseSubsetSchema = z
  .object({
    schemaVersion: z.literal(1),
    subsetId: z.literal(ACTIVATION_RELEASE_SUBSET_ID),
    sourceCorpusId: z.literal("autonomous-activation-v1"),
    sourceCorpusSha256: z.literal(ACTIVATION_CORPUS_SHA256),
    selectionRule: z.literal("corpus-order-first-n-per-stratum"),
    purpose: z.literal("pilot-release-candidate-evidence"),
    strata: z
      .object({
        cleanAutomatic: z.array(caseIdSchema).length(8),
        irrelevant: z.array(caseIdSchema).length(3),
        userRequestedExplicit: z.array(caseIdSchema).length(2),
        userRequestedWithoutIntent: z.array(caseIdSchema).length(2),
      })
      .strict(),
    caseIds: z.array(caseIdSchema).length(15),
  })
  .strict();

export type ActivationReleaseSubset = z.infer<typeof releaseSubsetSchema>;

export class ActivationReleaseSubsetError extends Error {
  public constructor(readonly code: string) {
    super(code);
    this.name = "ActivationReleaseSubsetError";
  }
}

export function loadActivationReleaseSubset(
  projectRoot: string,
): ActivationReleaseSubset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(join(projectRoot, ACTIVATION_RELEASE_SUBSET_PATH), "utf8"),
    ) as unknown;
  } catch {
    throw new ActivationReleaseSubsetError("RELEASE_SUBSET_UNREADABLE");
  }
  const result = releaseSubsetSchema.safeParse(parsed);
  if (!result.success) {
    throw new ActivationReleaseSubsetError("RELEASE_SUBSET_SCHEMA_INVALID");
  }
  return result.data;
}

export function validateActivationReleaseSubset(
  projectRoot: string,
  corpus: ActivationCorpus,
): ActivationReleaseSubset {
  const subset = loadActivationReleaseSubset(projectRoot);
  const corpusBytes = readFileSync(
    join(projectRoot, "evaluation/autonomous-activation.v1.json"),
  );
  if (
    createHash("sha256").update(corpusBytes).digest("hex") !==
    ACTIVATION_CORPUS_SHA256
  ) {
    throw new ActivationReleaseSubsetError("RELEASE_SUBSET_CORPUS_MISMATCH");
  }

  const expectedStrata = {
    cleanAutomatic: corpus.cases
      .filter(
        (entry) =>
          entry.scenarioClass === "automatic-relevant" &&
          entry.localSkillFixture === undefined &&
          entry.failureMode === undefined,
      )
      .slice(0, 8)
      .map(({ id }) => id),
    irrelevant: corpus.cases
      .filter(({ scenarioClass }) => scenarioClass === "irrelevant")
      .slice(0, 3)
      .map(({ id }) => id),
    userRequestedExplicit: corpus.cases
      .filter(
        ({ scenarioClass }) => scenarioClass === "user-requested-explicit",
      )
      .slice(0, 2)
      .map(({ id }) => id),
    userRequestedWithoutIntent: corpus.cases
      .filter(
        ({ scenarioClass }) =>
          scenarioClass === "user-requested-without-intent",
      )
      .slice(0, 2)
      .map(({ id }) => id),
  };
  const expectedCaseIds = [
    ...expectedStrata.cleanAutomatic,
    ...expectedStrata.irrelevant,
    ...expectedStrata.userRequestedExplicit,
    ...expectedStrata.userRequestedWithoutIntent,
  ];
  if (
    JSON.stringify(subset.strata) !== JSON.stringify(expectedStrata) ||
    JSON.stringify(subset.caseIds) !== JSON.stringify(expectedCaseIds) ||
    new Set(subset.caseIds).size !== subset.caseIds.length
  ) {
    throw new ActivationReleaseSubsetError("RELEASE_SUBSET_SELECTION_MISMATCH");
  }

  const byId = new Map(corpus.cases.map((entry) => [entry.id, entry]));
  for (let index = 0; index < 2; index += 1) {
    const explicit = byId.get(
      expectedStrata.userRequestedExplicit[index] ?? "",
    );
    const withoutIntent = byId.get(
      expectedStrata.userRequestedWithoutIntent[index] ?? "",
    );
    if (
      explicit?.pairId === undefined ||
      explicit.pairId !== withoutIntent?.pairId
    ) {
      throw new ActivationReleaseSubsetError("RELEASE_SUBSET_PAIR_MISMATCH");
    }
  }
  return subset;
}
