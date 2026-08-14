import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { AsyncSkillCatalogProvider } from "../application/ports/async-skill-catalog-provider.js";
import type { RepositoryMemoryStore } from "../application/ports/repository-memory-store.js";
import { createLoadSkill } from "../application/use-cases/load-skill.js";
import { createReadSkillResource } from "../application/use-cases/read-skill-resource.js";
import { createSearchSkills } from "../application/use-cases/search-skills.js";
import type { RequestPrincipal } from "../domain/repository-memory/types.js";

const caseBase = {
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(96),
  task: z.string().trim().min(1).max(4096),
  expectedSkillName: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(120),
  invocationContext: z.enum(["automatic", "user-requested"]),
} as const;

const searchCorpusSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpusId: z.literal("github-import-search-v1"),
    minimumSuccessRate: z.number().min(0.9).max(1),
    cases: z.array(z.object(caseBase).strict()).min(40).max(1000),
  })
  .strict();

const journeyMatrixSchema = z
  .object({
    schemaVersion: z.literal(1),
    matrixId: z.literal("github-import-journeys-v1"),
    minimumSuccessRate: z.number().min(0.9).max(1),
    acceptance: z
      .object({
        skillCount: z.literal(25),
        userOnlyCount: z.literal(14),
        resourceCount: z.literal(21),
        excludedClassifications: z.tuple([
          z.literal("discovered"),
          z.literal("quarantined"),
        ]),
        grillWithDocsDependencies: z.tuple([
          z.literal("domain-modeling"),
          z.literal("grilling"),
        ]),
      })
      .strict(),
    cases: z
      .array(
        z
          .object({
            ...caseBase,
            resourcePaths: z.array(z.string().min(1).max(240)).max(64),
          })
          .strict(),
      )
      .min(25)
      .max(1000),
  })
  .strict();

export type GitHubImportSearchCorpus = z.infer<typeof searchCorpusSchema>;
export type GitHubImportJourneyMatrix = z.infer<typeof journeyMatrixSchema>;

export function loadGitHubImportSearchCorpus(
  projectRoot: string,
): GitHubImportSearchCorpus {
  return searchCorpusSchema.parse(
    JSON.parse(
      readFileSync(
        join(projectRoot, "evaluation", "github-import-search.v1.json"),
        "utf8",
      ),
    ) as unknown,
  );
}

export function loadGitHubImportJourneyMatrix(
  projectRoot: string,
): GitHubImportJourneyMatrix {
  return journeyMatrixSchema.parse(
    JSON.parse(
      readFileSync(
        join(projectRoot, "evaluation", "github-import-journeys.v1.json"),
        "utf8",
      ),
    ) as unknown,
  );
}

export async function validateGitHubImportEvaluation(
  provider: AsyncSkillCatalogProvider,
  searchCorpus: GitHubImportSearchCorpus,
  journeyMatrix: GitHubImportJourneyMatrix,
): Promise<void> {
  const metadata = await provider.listMetadata();
  const imported = metadata.filter(
    ({ catalogOrigin }) => catalogOrigin?.kind === "github",
  );
  const names = new Set(imported.map(({ name }) => name));
  if (names.size !== journeyMatrix.acceptance.skillCount) {
    throw new Error("IMPORT_EVALUATION_INVENTORY_INVALID");
  }
  if (
    imported.filter(({ invocationMode }) => invocationMode === "user-only")
      .length !== journeyMatrix.acceptance.userOnlyCount
  ) {
    throw new Error("IMPORT_EVALUATION_INVOCATION_INVALID");
  }
  const expectedNames = new Set([
    ...searchCorpus.cases.map(({ expectedSkillName }) => expectedSkillName),
    ...journeyMatrix.cases.map(({ expectedSkillName }) => expectedSkillName),
  ]);
  if (
    expectedNames.size !== 25 ||
    [...names].some((name) => !expectedNames.has(name))
  ) {
    throw new Error("IMPORT_EVALUATION_COVERAGE_INVALID");
  }
  if (
    journeyMatrix.cases.reduce(
      (total, entry) => total + entry.resourcePaths.length,
      0,
    ) !== journeyMatrix.acceptance.resourceCount
  ) {
    throw new Error("IMPORT_EVALUATION_RESOURCE_COVERAGE_INVALID");
  }
  for (const collection of [searchCorpus.cases, journeyMatrix.cases]) {
    const identifiers = new Set(collection.map(({ id }) => id));
    if (identifiers.size !== collection.length) {
      throw new Error("IMPORT_EVALUATION_DUPLICATE_CASE");
    }
  }
}

export interface GitHubImportEvaluationResult {
  readonly total: number;
  readonly successful: number;
  readonly successRate: number;
  readonly failedCaseIds: readonly string[];
}

const evaluationPrincipal: RequestPrincipal = {
  accountId: "00000000-0000-4000-8000-000000000801",
  apiKeyId: "00000000-0000-4000-8000-000000000802",
  requestId: "github-import-evaluation",
};

export async function evaluateGitHubImportSearch(
  provider: AsyncSkillCatalogProvider,
  memory: RepositoryMemoryStore,
  corpus: GitHubImportSearchCorpus,
): Promise<GitHubImportEvaluationResult> {
  const search = createSearchSkills(provider, memory);
  const failedCaseIds: string[] = [];
  for (const evaluationCase of corpus.cases) {
    const result = await search.execute(
      {
        task: evaluationCase.task,
        invocationContext: evaluationCase.invocationContext,
        limit: 3,
      },
      evaluationPrincipal,
    );
    if (
      !result.skills.some(
        ({ name }) => name === evaluationCase.expectedSkillName,
      )
    ) {
      failedCaseIds.push(evaluationCase.id);
    }
  }
  return result(corpus.cases.length, failedCaseIds);
}

export async function evaluateGitHubImportJourneys(
  provider: AsyncSkillCatalogProvider,
  memory: RepositoryMemoryStore,
  matrix: GitHubImportJourneyMatrix,
): Promise<GitHubImportEvaluationResult & { readonly resourceCount: number }> {
  const search = createSearchSkills(provider, memory);
  const load = createLoadSkill(provider, memory);
  const read = createReadSkillResource(provider);
  const failedCaseIds: string[] = [];
  let resourceCount = 0;
  for (const evaluationCase of matrix.cases) {
    try {
      const searched = await search.execute(
        {
          task: evaluationCase.task,
          invocationContext: evaluationCase.invocationContext,
          limit: 1,
        },
        evaluationPrincipal,
      );
      const selected = searched.skills[0];
      if (selected?.name !== evaluationCase.expectedSkillName) {
        throw new Error("SEARCH_MISMATCH");
      }
      const loaded = await load.execute(
        { skillId: selected.skillId, revision: selected.revision },
        evaluationPrincipal,
      );
      expectSameResources(
        loaded.resourceManifest.map(({ path }) => path),
        evaluationCase.resourcePaths,
      );
      const firstResource = evaluationCase.resourcePaths[0];
      if (firstResource !== undefined) {
        await read.execute(
          {
            skillId: loaded.skillId,
            revision: loaded.revision,
            path: firstResource,
          },
          evaluationPrincipal,
        );
      }
      resourceCount += loaded.resourceManifest.length;
    } catch {
      failedCaseIds.push(evaluationCase.id);
    }
  }
  return { ...result(matrix.cases.length, failedCaseIds), resourceCount };
}

function expectSameResources(
  actual: readonly string[],
  expected: readonly string[],
): void {
  if (
    actual.length !== expected.length ||
    actual.toSorted().some((path, index) => path !== expected.toSorted()[index])
  ) {
    throw new Error("RESOURCE_MANIFEST_MISMATCH");
  }
}

function result(
  total: number,
  failedCaseIds: readonly string[],
): GitHubImportEvaluationResult {
  return {
    total,
    successful: total - failedCaseIds.length,
    successRate: (total - failedCaseIds.length) / total,
    failedCaseIds,
  };
}
