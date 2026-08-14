import {
  DiagnosticFindingSchema,
  type DiagnosticFinding,
} from "../domain/diagnostics.js";

export function runDoctor(
  findings: readonly DiagnosticFinding[],
): Promise<readonly DiagnosticFinding[]> {
  return Promise.resolve(
    findings
      .map((finding) => DiagnosticFindingSchema.parse(finding))
      .sort((left, right) =>
        left.code === right.code
          ? left.component.localeCompare(right.component)
          : left.code.localeCompare(right.code),
      ),
  );
}
