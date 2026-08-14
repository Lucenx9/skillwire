import { describe, expect, it } from "vitest";

import {
  diagnosticProbe,
  runDiagnosticProbes,
  type DiagnosticCondition,
} from "../../../src/onboarding/application/diagnostic-probes.js";
import { runDoctor } from "../../../src/onboarding/application/doctor.js";

describe("layered doctor classification", () => {
  it("classifies every FR-061 condition with stable redacted guidance", async () => {
    const fixtures: readonly [DiagnosticCondition, string][] = [
      ["service-stopped", "SERVICE_STOPPED"],
      ["postgres-unavailable", "POSTGRES_UNAVAILABLE"],
      ["migration-pending", "MIGRATION_PENDING"],
      ["schema-incompatible", "SCHEMA_INCOMPATIBLE"],
      ["schema-drifted", "SCHEMA_DRIFTED"],
      ["catalog-invalid", "CATALOG_INTEGRITY_INVALID"],
      ["advisory-invalid", "ADVISORY_INTEGRITY_INVALID"],
      ["client-missing", "CLIENT_MISSING"],
      ["client-version-unsupported", "CLIENT_VERSION_UNSUPPORTED"],
      ["plugin-missing", "PLUGIN_MISSING"],
      ["plugin-outdated", "PLUGIN_OUTDATED"],
      ["mcp-absent", "MCP_CONFIGURATION_ABSENT"],
      ["mcp-conflicting", "MCP_CONFIGURATION_CONFLICTING"],
      ["mcp-duplicate", "MCP_CONFIGURATION_DUPLICATE"],
      ["credential-unavailable", "CREDENTIAL_UNAVAILABLE"],
      ["authentication-rejected", "AUTHENTICATION_REJECTED"],
      ["endpoint-unreachable", "ENDPOINT_UNREACHABLE"],
      ["tool-contract-mismatch", "TOOL_CONTRACT_MISMATCH"],
      ["activation-adapter-unavailable", "ACTIVATION_ADAPTER_UNAVAILABLE"],
      ["source-degraded", "SOURCE_SYNCHRONIZATION_DEGRADED"],
      ["release-invalid", "RELEASE_INTEGRITY_INVALID"],
      ["trust-policy-invalid", "TRUST_POLICY_INVALID"],
      ["service-secret-unsafe", "SERVICE_SECRET_UNSAFE"],
      ["ownership-drifted", "OWNERSHIP_DRIFTED"],
      ["operation-locked", "OPERATION_LOCKED"],
      ["backup-invalid", "BACKUP_INVALID"],
      ["journal-recovery-required", "JOURNAL_RECOVERY_REQUIRED"],
    ];
    const probes = fixtures.map(([condition]) =>
      diagnosticProbe(condition, {
        observed: "categorical",
        unsafeInput:
          "swk.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    );

    const report = await runDoctor(
      await runDiagnosticProbes(probes, new AbortController().signal),
    );

    expect(report.map(({ code }) => code)).toEqual(
      fixtures.map(([, code]) => code).sort(),
    );
    expect(JSON.stringify(report)).not.toMatch(/swk\.|Bearer|password|pepper/i);
    expect(report.every(({ nextAction }) => nextAction.length > 0)).toBe(true);
  });
});
