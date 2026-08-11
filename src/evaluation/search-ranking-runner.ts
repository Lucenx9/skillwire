import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { rankSkills } from "../domain/catalog/ranking.js";
import type { CatalogSkillMetadata } from "../domain/catalog/types.js";

const evaluationCaseSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(96),
    task: z.string().trim().min(1).max(4096),
    expectedSkillId: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    rationale: z.string().trim().min(1).max(512),
  })
  .strict();

const corpusSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpusId: z.literal("search-ranking-v1"),
    cases: z.array(evaluationCaseSchema).min(30).max(1000),
  })
  .strict();

export type SearchEvaluationCorpus = z.infer<typeof corpusSchema>;

export interface SearchEvaluationResult {
  readonly total: number;
  readonly matchingTopThree: number;
  readonly successRate: number;
  readonly failedCaseIds: readonly string[];
}

export function loadSearchEvaluationCorpus(projectRoot: string): unknown {
  return JSON.parse(
    readFileSync(
      join(projectRoot, "evaluation", "search-ranking.v1.json"),
      "utf8",
    ),
  ) as unknown;
}

export function validateSearchEvaluationCorpus(
  value: unknown,
  catalog: readonly CatalogSkillMetadata[],
): SearchEvaluationCorpus {
  const corpus = corpusSchema.parse(value);
  const caseIds = new Set<string>();
  const catalogIds = new Set(catalog.map((entry) => entry.id));
  const coverage = new Map(catalog.map((entry) => [entry.id, 0]));

  for (const evaluationCase of corpus.cases) {
    if (caseIds.has(evaluationCase.id)) {
      throw new Error("Search evaluation case identifiers must be unique");
    }
    caseIds.add(evaluationCase.id);
    if (!catalogIds.has(evaluationCase.expectedSkillId)) {
      throw new Error("Search evaluation references an unknown skill");
    }
    coverage.set(
      evaluationCase.expectedSkillId,
      (coverage.get(evaluationCase.expectedSkillId) ?? 0) + 1,
    );
  }
  if ([...coverage.values()].some((count) => count < 3)) {
    throw new Error("Search evaluation requires three cases per skill");
  }
  return corpus;
}

export function evaluateSearchRanking(
  catalog: readonly CatalogSkillMetadata[],
  corpus: SearchEvaluationCorpus,
): SearchEvaluationResult {
  const failedCaseIds: string[] = [];
  for (const evaluationCase of corpus.cases) {
    const topThree = rankSkills(catalog, evaluationCase.task, 3);
    if (
      !topThree.some(
        (result) => result.skill.id === evaluationCase.expectedSkillId,
      )
    ) {
      failedCaseIds.push(evaluationCase.id);
    }
  }
  const matchingTopThree = corpus.cases.length - failedCaseIds.length;
  return {
    total: corpus.cases.length,
    matchingTopThree,
    successRate: matchingTopThree / corpus.cases.length,
    failedCaseIds,
  };
}
