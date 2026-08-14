import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const ACCEPTANCE_EVIDENCE = [
  ["US1-1", "tests/e2e/self-hosted-onboarding/setup-matrix.test.ts"],
  ["US1-2", "tests/e2e/self-hosted-onboarding/setup-matrix.test.ts"],
  ["US1-3", "tests/e2e/self-hosted-onboarding/setup-matrix.test.ts"],
  ["US1-4", "tests/integration/onboarding/production-setup.test.ts"],
  [
    "US1-5",
    "tests/e2e/self-hosted-onboarding/client-conflict-partial-success.test.ts",
  ],
  ["US2-1", "tests/e2e/self-hosted-onboarding/profile-safety.test.ts"],
  ["US2-2", "tests/e2e/self-hosted-onboarding/profile-safety.test.ts"],
  [
    "US2-3",
    "tests/e2e/self-hosted-onboarding/client-conflict-partial-success.test.ts",
  ],
  [
    "US2-4",
    "tests/e2e/self-hosted-onboarding/external-integration-reuse.test.ts",
  ],
  ["US2-5", "tests/e2e/self-hosted-onboarding/profile-safety.test.ts"],
  ["US3-1", "tests/e2e/self-hosted-onboarding/fail-open-clients.test.ts"],
  ["US3-2", "tests/e2e/self-hosted-onboarding/fail-open-clients.test.ts"],
  ["US3-3", "tests/e2e/self-hosted-onboarding/fail-open-clients.test.ts"],
  [
    "US3-4",
    "tests/e2e/self-hosted-onboarding/explicit-skillwire-request.test.ts",
  ],
  ["US4-1", "tests/e2e/self-hosted-onboarding/repeated-setup.test.ts"],
  ["US4-2", "tests/integration/onboarding/interruption-recovery.test.ts"],
  ["US4-3", "tests/integration/onboarding/doctor-classification.test.ts"],
  ["US4-4", "tests/integration/onboarding/repair.test.ts"],
  ["US5-1", "tests/integration/onboarding/upgrade-compatible.test.ts"],
  ["US5-2", "tests/integration/onboarding/upgrade-forward-only-010.test.ts"],
  ["US5-3", "tests/integration/onboarding/upgrade-interruption.test.ts"],
  ["US6-1", "tests/e2e/self-hosted-onboarding/default-uninstall.test.ts"],
  ["US6-2", "tests/e2e/self-hosted-onboarding/reinstall-retained-data.test.ts"],
  ["US6-3", "tests/e2e/self-hosted-onboarding/permanent-removal.test.ts"],
  ["US7-1", "tests/e2e/self-hosted-onboarding/first-party-catalog.test.ts"],
  ["US7-2", "tests/integration/onboarding/source-bootstrap.test.ts"],
  ["US7-3", "tests/security/onboarding/source-boundaries.test.ts"],
  ["US7-4", "tests/integration/onboarding/source-degradation.test.ts"],
] as const;

const FR_EVIDENCE_GROUPS = [
  [1, 16, "tests/e2e/self-hosted-onboarding/setup-matrix.test.ts"],
  [17, 23, "tests/contract/clients/codex-onboarding.test.ts"],
  [24, 29, "tests/contract/clients/claude-onboarding.test.ts"],
  [30, 36, "tests/e2e/self-hosted-onboarding/profile-safety.test.ts"],
  [37, 44, "tests/security/onboarding/secret-containment.test.ts"],
  [45, 50, "tests/e2e/self-hosted-onboarding/fail-open-clients.test.ts"],
  [51, 57, "tests/e2e/self-hosted-onboarding/first-party-catalog.test.ts"],
  [58, 65, "tests/contract/cli/lifecycle-operations.test.ts"],
  [66, 73, "tests/e2e/self-hosted-onboarding/upgrade-preservation.test.ts"],
  [74, 77, "tests/e2e/self-hosted-onboarding/default-uninstall.test.ts"],
  [78, 85, "tests/security/onboarding/source-boundaries.test.ts"],
  [86, 91, "tests/e2e/self-hosted-onboarding/acceptance-scenarios.test.ts"],
  [92, 92, "tests/contract/release/self-hosted-matrix.test.ts"],
] as const;

const FR_EVIDENCE = FR_EVIDENCE_GROUPS.flatMap(([first, last, path]) =>
  Array.from({ length: last - first + 1 }, (_, index) => ({
    id: `FR-${String(first + index).padStart(3, "0")}`,
    path,
  })),
);

const BUILDABLE_SC_EVIDENCE = [
  [2, "tests/e2e/self-hosted-onboarding/client-verification.test.ts"],
  [3, "tests/e2e/self-hosted-onboarding/fail-open-clients.test.ts"],
  [4, "tests/e2e/self-hosted-onboarding/profile-safety.test.ts"],
  [5, "tests/e2e/self-hosted-onboarding/repeated-setup.test.ts"],
  [6, "tests/integration/onboarding/interruption-recovery.test.ts"],
  [7, "tests/integration/onboarding/doctor-classification.test.ts"],
  [8, "tests/security/onboarding/secret-containment.test.ts"],
  [9, "tests/e2e/self-hosted-onboarding/first-party-catalog.test.ts"],
  [10, "tests/e2e/self-hosted-onboarding/default-uninstall.test.ts"],
  [11, "tests/e2e/self-hosted-onboarding/permanent-removal.test.ts"],
  [12, "tests/e2e/self-hosted-onboarding/upgrade-preservation.test.ts"],
  [13, "tests/e2e/self-hosted-onboarding/acceptance-scenarios.test.ts"],
  [15, "tests/security/onboarding/bounded-activation.test.ts"],
  [
    16,
    "tests/e2e/self-hosted-onboarding/client-conflict-partial-success.test.ts",
  ],
  [17, "tests/e2e/self-hosted-onboarding/external-integration-reuse.test.ts"],
] as const;

async function requireExecutableEvidence(
  entries: readonly { readonly id: string; readonly path: string }[],
): Promise<void> {
  for (const { id, path } of entries) {
    await expect(access(path), `${id}: ${path}`).resolves.toBeUndefined();
    expect(await readFile(path, "utf8"), id).toMatch(
      /\b(?:it|test)(?:\.skipIf|\.each)?/,
    );
  }
}

describe("Feature 004 acceptance traceability", () => {
  it("maps all 28 numbered scenarios to executable evidence", async () => {
    expect(ACCEPTANCE_EVIDENCE).toHaveLength(28);
    expect(new Set(ACCEPTANCE_EVIDENCE.map(([id]) => id)).size).toBe(28);
    for (const [id, path] of ACCEPTANCE_EVIDENCE) {
      await expect(access(path), `${id}: ${path}`).resolves.toBeUndefined();
      expect(await readFile(path, "utf8"), id).toMatch(
        /\b(?:it|test)(?:\.skipIf|\.each)?/,
      );
    }
  });

  it("keeps FR-001 through FR-092 and every buildable success criterion represented", async () => {
    const specification = await readFile(
      "specs/004-self-hosted-onboarding/spec.md",
      "utf8",
    );
    const requirements = [...specification.matchAll(/\*\*FR-(\d{3})\*\*/g)].map(
      (match) => Number(match[1]),
    );
    expect(requirements).toEqual(
      Array.from({ length: 92 }, (_, index) => index + 1),
    );
    expect(FR_EVIDENCE.map(({ id }) => id)).toEqual(
      requirements.map((id) => `FR-${String(id).padStart(3, "0")}`),
    );
    await requireExecutableEvidence(FR_EVIDENCE);
    const successCriteria = [
      ...specification.matchAll(/\*\*SC-(\d{3})\*\*/g),
    ].map((match) => Number(match[1]));
    expect(successCriteria).toEqual(
      Array.from({ length: successCriteria.length }, (_, index) => index + 1),
    );
    expect(BUILDABLE_SC_EVIDENCE.map(([id]) => id)).toEqual(
      successCriteria.filter((id) => id !== 1 && id !== 14),
    );
    await requireExecutableEvidence(
      BUILDABLE_SC_EVIDENCE.map(([id, path]) => ({
        id: `SC-${String(id).padStart(3, "0")}`,
        path,
      })),
    );
  });
});

export { ACCEPTANCE_EVIDENCE, BUILDABLE_SC_EVIDENCE, FR_EVIDENCE };
