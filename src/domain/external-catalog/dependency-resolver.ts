import type {
  ExternalDependencyInput,
  ExternalValidationFinding,
} from "./types.js";

export interface DependencyResolution {
  readonly dependencies: readonly ExternalDependencyInput[];
  readonly findings: readonly ExternalValidationFinding[];
}

export function resolveInternalDependencies(
  snapshotSkillNames: readonly string[],
  sourceSkillName: string,
  evidence: readonly ExternalDependencyInput[],
): DependencyResolution {
  const counts = new Map<string, number>();
  for (const name of snapshotSkillNames)
    counts.set(name, (counts.get(name) ?? 0) + 1);
  const dependencies: ExternalDependencyInput[] = [];
  const findings: ExternalValidationFinding[] = [];
  for (const candidate of evidence) {
    const count = counts.get(candidate.skillName) ?? 0;
    const subjectId = `${sourceSkillName}:${candidate.skillName}`;
    if (candidate.skillName === sourceSkillName || count > 1) {
      if (
        candidate.required &&
        candidate.evidenceKind !== "explicit-invocation"
      ) {
        findings.push({
          code: "DEPENDENCY_AMBIGUOUS",
          severity: "error",
          subjectKind: "candidate",
          subjectId,
        });
      }
      continue;
    }
    if (count === 0) {
      if (
        candidate.required &&
        candidate.evidenceKind !== "explicit-invocation"
      ) {
        findings.push({
          code: "DEPENDENCY_MISSING",
          severity: "error",
          subjectKind: "candidate",
          subjectId,
        });
      }
      continue;
    }
    dependencies.push(candidate);
  }
  return {
    dependencies: dependencies.toSorted((a, b) =>
      a.skillName.localeCompare(b.skillName, "en-US"),
    ),
    findings: findings.toSorted((a, b) =>
      a.subjectId.localeCompare(b.subjectId, "en-US"),
    ),
  };
}

export function dependencyCycleMembers(
  graph: ReadonlyMap<string, readonly ExternalDependencyInput[]>,
): ReadonlySet<string> {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const index = stack.indexOf(name);
      for (const member of stack.slice(index)) cyclic.add(member);
      return;
    }
    visiting.add(name);
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency.skillName);
    stack.pop();
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) visit(name);
  return cyclic;
}
