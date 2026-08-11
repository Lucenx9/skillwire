import type { SkillOutcome } from "./types.js";

const OUTCOMES = new Set<SkillOutcome>(["useful", "neutral", "unsuccessful"]);

export function parseSkillOutcome(value: string): SkillOutcome {
  if (!OUTCOMES.has(value as SkillOutcome)) {
    throw new Error("Outcome must be useful, neutral, or unsuccessful");
  }
  return value as SkillOutcome;
}

export function memoryBoostForOutcome(outcome: SkillOutcome | null): number {
  if (outcome === "useful") return 2;
  if (outcome === "unsuccessful") return 0;
  return 1;
}
