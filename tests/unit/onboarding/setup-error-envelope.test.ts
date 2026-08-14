import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ProductionSetupMutationError } from "../../../src/onboarding/application/production-setup.js";
import { setupFailureEnvelope } from "../../../src/onboarding/cli/command-router.js";

describe("setup failure envelope mutation truthfulness", () => {
  it("marks a post-install failure as changed and recovery-required", () => {
    const result = setupFailureEnvelope({
      error: new ProductionSetupMutationError("readiness failed"),
      operationId: randomUUID(),
      previewHash: "a".repeat(64),
      cancelled: false,
    });
    expect(result).toMatchObject({
      status: "recovery-required",
      exitClass: "rollback-required",
      previewHash: "a".repeat(64),
      changed: true,
      recovery: { rollbackBoundary: "application-config" },
    });
  });

  it("keeps a release preflight failure non-mutating", () => {
    const result = setupFailureEnvelope({
      error: new Error("Release manifest rejected"),
      operationId: randomUUID(),
      previewHash: null,
      cancelled: false,
    });
    expect(result).toMatchObject({
      status: "failure",
      exitClass: "release-integrity-failure",
      previewHash: null,
      changed: false,
      recovery: { rollbackBoundary: "none" },
    });
  });

  it("reports a committed healthy service as changed when optional-source input is cancelled", () => {
    const result = setupFailureEnvelope({
      error: new Error("GitHub source credential input cancelled"),
      operationId: randomUUID(),
      previewHash: "b".repeat(64),
      cancelled: true,
      changed: true,
    });
    expect(result).toMatchObject({
      status: "cancelled",
      exitClass: "user-cancellation",
      changed: true,
      recovery: { rollbackBoundary: "none" },
    });
  });
});
