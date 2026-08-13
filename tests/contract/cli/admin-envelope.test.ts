import { describe, expect, it } from "vitest";

import {
  AdminResultSchema,
  renderAdminResult,
} from "../../../src/onboarding/cli/output.js";
import {
  canonicalPreview,
  confirmPreview,
  exitCodeForClass,
} from "../../../src/onboarding/cli/confirmation.js";

describe("administrative envelope and confirmation", () => {
  it("canonicalizes a redacted preview and requires its exact hash", () => {
    const preview = canonicalPreview("setup", {
      clients: ["codex"],
      token: "swk.fixture.fixture",
    });
    expect(preview.json).not.toContain("swk.fixture.fixture");
    expect(preview.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => confirmPreview(preview, "0".repeat(64))).toThrow(/preview/i);
    expect(confirmPreview(preview, preview.hash)).toBe(true);
  });

  it("renders exactly one JSON envelope with stable exit classes and no secrets", () => {
    const result = AdminResultSchema.parse({
      schemaVersion: "skillwire.admin-result/v1",
      command: "status",
      operationId: "00000000-0000-4000-8000-000000000001",
      status: "success",
      exitClass: "success",
      previewHash: null,
      changed: false,
      summary: "Installation is healthy",
      components: [],
      findings: [],
      recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
    });
    const rendered = renderAdminResult(result, "json");
    expect(rendered.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(rendered)).toEqual(result);
    expect(exitCodeForClass("release-integrity-failure")).toBe(12);
  });
});
