import type { CatalogSkillMetadata, RankedSkill } from "./types.js";
import { memoryBoostForOutcome } from "../repository-memory/outcome.js";
import type { RepositoryUsageProjection } from "../repository-memory/types.js";

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

export const MINIMUM_RELEVANCE_SCORE = 1;

function normalizeToken(token: string): string {
  const normalized = token.normalize("NFKD").toLocaleLowerCase("en-US");
  if (normalized.length > 3 && normalized.endsWith("s")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function tokenize(value: string): Set<string> {
  return new Set(
    (value.match(TOKEN_PATTERN) ?? []).map((token) => normalizeToken(token)),
  );
}

function intersectionSize(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  let matches = 0;
  for (const token of left) {
    if (right.has(token)) matches += 1;
  }
  return matches;
}

function scoreSkill(
  skill: CatalogSkillMetadata,
  task: string,
  memoryBoost: number,
): RankedSkill {
  const queryTokens = tokenize(task);
  const identityTokens = tokenize(`${skill.id} ${skill.name}`);
  const descriptionTokens = tokenize(skill.description);
  const capabilityTokens = tokenize(skill.capabilities.join(" "));
  const normalizedTask = [...queryTokens].join(" ");

  let score = intersectionSize(queryTokens, identityTokens) * 6;
  score += intersectionSize(queryTokens, capabilityTokens) * 8;
  score += intersectionSize(queryTokens, descriptionTokens) * 2;

  const matchingCapabilities = skill.capabilities.filter((capability) => {
    const tokens = tokenize(capability);
    const matched = intersectionSize(queryTokens, tokens) > 0;
    if (matched && normalizedTask.includes([...tokens].join(" "))) score += 4;
    return matched;
  });

  return { skill, score, memoryBoost, matchingCapabilities };
}

export function rankSkills(
  skills: readonly CatalogSkillMetadata[],
  task: string,
  limit: number,
  memory: readonly RepositoryUsageProjection[] = [],
): RankedSkill[] {
  const memoryByRevision = new Map(
    memory.map((entry) => [
      `${entry.skillId}\0${entry.revision}`,
      memoryBoostForOutcome(entry.outcome),
    ]),
  );
  return skills
    .filter((skill) => skill.currentAdvisoryStatus !== "revoked")
    .map((skill) =>
      scoreSkill(
        skill,
        task,
        memoryByRevision.get(`${skill.id}\0${skill.revision}`) ?? 0,
      ),
    )
    .filter((result) => result.score >= MINIMUM_RELEVANCE_SCORE)
    .sort((left, right) => {
      const relevance = right.score - left.score;
      if (relevance !== 0) return relevance;
      const memoryRelevance = right.memoryBoost - left.memoryBoost;
      if (memoryRelevance !== 0) return memoryRelevance;
      return left.skill.id.localeCompare(right.skill.id, "en-US");
    })
    .slice(0, limit);
}
