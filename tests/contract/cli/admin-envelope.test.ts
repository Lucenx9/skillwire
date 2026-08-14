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

  it("renders the complete redacted scope bound to a setup approval", () => {
    const previewScope = {
      releaseRoot: "/disposable/release",
      releaseVersion: "0.1.0-test.1",
      releaseSequence: 1,
      manifestSha256: "a".repeat(64),
      archiveSha256: "b".repeat(64),
      trustPolicySequence: 1,
      architecture: "amd64",
      clients: "codex,claude",
      endpoint: "unix:///run/user/1000/skillwire/<installation-id>/mcp.sock",
      transport: "unix-domain-socket",
      port: null,
      composeProjectPattern: "skillwire-<installation-id>",
      postgresVolumePattern: "skillwire-<installation-id>_postgres_data",
      serviceSecretRoot:
        "/disposable/data/skillwire/installations/<installation-id>/secrets",
      runtimeSocketRoot:
        "/disposable/runtime/skillwire/installations/<installation-id>",
      credentialBackend: "secret-service",
      fallbackRiskConfirmedByThisPreview: false,
      components: [
        "service",
        "postgres",
        "credential-bridge",
        "codex",
        "claude",
      ],
      volumes: ["skillwire-<installation-id>_postgres_data"],
      retainedOnFailure: [
        "verified release",
        "service data",
        "service secrets",
      ],
      catalogChoice: "deferred",
    };
    const preview = canonicalPreview("setup", previewScope);
    const result = AdminResultSchema.parse({
      schemaVersion: "skillwire.admin-result/v1",
      command: "setup",
      operationId: "00000000-0000-4000-8000-000000000001",
      status: "preview",
      exitClass: "success",
      previewHash: preview.hash,
      previewScope,
      changed: false,
      summary: "Validated setup preview",
      components: [],
      findings: [],
      recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
    });
    const human = renderAdminResult(result, "human");
    expect(human).toContain(preview.hash);
    for (const field of [
      "endpoint",
      "transport",
      "port",
      "serviceSecretRoot",
      "runtimeSocketRoot",
      "clients",
      "components",
      "volumes",
      "credentialBackend",
      "retainedOnFailure",
      "catalogChoice",
    ])
      expect(human).toContain(field);
  });
});
