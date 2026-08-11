import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { RepositoryMemoryStore } from "../application/ports/repository-memory-store.js";
import type { SkillCatalogProvider } from "../application/ports/skill-catalog-provider.js";
import { createLoadSkill } from "../application/use-cases/load-skill.js";
import { createReadSkillResource } from "../application/use-cases/read-skill-resource.js";
import { createSearchSkills } from "../application/use-cases/search-skills.js";
import type { RequestPrincipal } from "../domain/repository-memory/types.js";

const journeyCaseSchema = z
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
    resourcePath: z
      .string()
      .regex(
        /^(?!\/)(?!.*(?:^|\/)\.\.?($|\/))(?!.*\\)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/,
      )
      .max(240)
      .optional(),
  })
  .strict();

const matrixSchema = z
  .object({
    schemaVersion: z.literal(1),
    matrixId: z.literal("three-call-journeys-v1"),
    cases: z.array(journeyCaseSchema).min(20).max(1000),
  })
  .strict();

export type JourneyEvaluationMatrix = z.infer<typeof matrixSchema>;

export interface JourneyCaseResult {
  readonly id: string;
  readonly selectedSkillId: string | null;
  readonly searchCalls: 1;
  readonly loadCalls: 1;
  readonly resourceCalls: 0 | 1;
  readonly operationCount: 2 | 3;
  readonly success: boolean;
}

export interface JourneyEvaluationResult {
  readonly total: number;
  readonly successful: number;
  readonly successRate: number;
  readonly cases: readonly JourneyCaseResult[];
}

const evaluationPrincipal: RequestPrincipal = {
  accountId: "00000000-0000-4000-8000-000000000001",
  apiKeyId: "00000000-0000-4000-8000-000000000002",
  requestId: "00000000-0000-4000-8000-000000000003",
};

const noMemory: RepositoryMemoryStore = {
  recordUsage: () =>
    Promise.reject(new Error("Evaluation cannot write memory")),
  list: () => Promise.reject(new Error("Evaluation cannot read memory")),
  rankingProjection: () =>
    Promise.reject(new Error("Evaluation cannot read memory")),
  replaceOutcome: () =>
    Promise.reject(new Error("Evaluation cannot write memory")),
  forget: () => Promise.reject(new Error("Evaluation cannot erase memory")),
};

export function loadJourneyEvaluationMatrix(projectRoot: string): unknown {
  return JSON.parse(
    readFileSync(
      join(projectRoot, "evaluation", "three-call-journeys.v1.json"),
      "utf8",
    ),
  ) as unknown;
}

export function validateJourneyEvaluationMatrix(
  value: unknown,
  provider: SkillCatalogProvider,
): JourneyEvaluationMatrix {
  const matrix = matrixSchema.parse(value);
  const caseIds = new Set<string>();
  const metadata = new Map(
    provider.listMetadata().map((entry) => [entry.id, entry]),
  );
  for (const evaluationCase of matrix.cases) {
    if (caseIds.has(evaluationCase.id)) {
      throw new Error("Journey evaluation case identifiers must be unique");
    }
    caseIds.add(evaluationCase.id);
    const catalogEntry = metadata.get(evaluationCase.expectedSkillId);
    if (catalogEntry === undefined) {
      throw new Error("Journey evaluation references an unknown skill");
    }
    const revision = provider.findRevision(
      evaluationCase.expectedSkillId,
      catalogEntry.revision,
    );
    if (
      revision === undefined ||
      (evaluationCase.resourcePath !== undefined &&
        !revision.resourceManifest.some(
          (entry) => entry.path === evaluationCase.resourcePath,
        ))
    ) {
      throw new Error("Journey evaluation references an undeclared resource");
    }
  }
  return matrix;
}

export async function evaluateThreeCallJourneys(
  provider: SkillCatalogProvider,
  matrix: JourneyEvaluationMatrix,
): Promise<JourneyEvaluationResult> {
  const search = createSearchSkills(provider.listMetadata(), noMemory);
  const load = createLoadSkill(provider, noMemory);
  const readResource = createReadSkillResource(provider);
  const cases: JourneyCaseResult[] = [];

  for (const evaluationCase of matrix.cases) {
    const searched = await search.execute(
      { task: evaluationCase.task, limit: 1 },
      evaluationPrincipal,
    );
    const selected = searched.skills[0];
    let success = selected?.skillId === evaluationCase.expectedSkillId;
    try {
      if (selected === undefined) throw new Error("No search result");
      const loaded = await load.execute(
        { skillId: selected.skillId, revision: selected.revision },
        evaluationPrincipal,
      );
      if (evaluationCase.resourcePath !== undefined) {
        const resource = readResource.execute({
          skillId: loaded.skillId,
          revision: loaded.revision,
          path: evaluationCase.resourcePath,
        });
        success &&= resource.path === evaluationCase.resourcePath;
      }
    } catch {
      success = false;
    }
    const resourceCalls = evaluationCase.resourcePath === undefined ? 0 : 1;
    cases.push({
      id: evaluationCase.id,
      selectedSkillId: selected?.skillId ?? null,
      searchCalls: 1,
      loadCalls: 1,
      resourceCalls,
      operationCount: resourceCalls === 0 ? 2 : 3,
      success,
    });
  }

  const successful = cases.filter((entry) => entry.success).length;
  return {
    total: cases.length,
    successful,
    successRate: successful / cases.length,
    cases,
  };
}
