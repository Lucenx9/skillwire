import {
  DiagnosticFindingSchema,
  type DiagnosticFinding,
} from "../domain/diagnostics.js";
import { redactOutput } from "../cli/output.js";
import type { SourceChoice } from "../domain/source-choice.js";

export type DiagnosticCondition =
  | "service-stopped"
  | "postgres-unavailable"
  | "migration-pending"
  | "schema-incompatible"
  | "schema-drifted"
  | "catalog-invalid"
  | "advisory-invalid"
  | "client-missing"
  | "client-version-unsupported"
  | "plugin-missing"
  | "plugin-outdated"
  | "mcp-absent"
  | "mcp-conflicting"
  | "mcp-duplicate"
  | "credential-unavailable"
  | "authentication-rejected"
  | "endpoint-unreachable"
  | "tool-contract-mismatch"
  | "activation-adapter-unavailable"
  | "source-degraded"
  | "release-invalid"
  | "trust-policy-invalid"
  | "service-secret-unsafe"
  | "ownership-drifted"
  | "operation-locked"
  | "backup-invalid"
  | "journal-recovery-required";

export interface DiagnosticProbe {
  readonly id: string;
  run(signal: AbortSignal): Promise<DiagnosticFinding | null>;
}

interface Classification {
  readonly code: string;
  readonly component: DiagnosticFinding["component"];
  readonly severity: DiagnosticFinding["severity"];
  readonly summary: string;
  readonly nextAction: string;
}

const CLASSIFICATIONS: Readonly<Record<DiagnosticCondition, Classification>> = {
  "service-stopped": {
    code: "SERVICE_STOPPED",
    component: "docker",
    severity: "error",
    summary: "The owned service is stopped",
    nextAction: "Run repair after inspecting the owned Compose project",
  },
  "postgres-unavailable": {
    code: "POSTGRES_UNAVAILABLE",
    component: "postgres",
    severity: "error",
    summary: "PostgreSQL is unavailable",
    nextAction: "Restore PostgreSQL readiness before retrying",
  },
  "migration-pending": {
    code: "MIGRATION_PENDING",
    component: "migration",
    severity: "warning",
    summary: "A supported migration is pending",
    nextAction: "Run a verified upgrade with a restore-validated backup",
  },
  "schema-incompatible": {
    code: "SCHEMA_INCOMPATIBLE",
    component: "migration",
    severity: "error",
    summary: "The live schema is incompatible",
    nextAction: "Select a release compatible with the live schema",
  },
  "schema-drifted": {
    code: "SCHEMA_DRIFTED",
    component: "migration",
    severity: "recovery-required",
    summary: "The live schema identity has drifted",
    nextAction: "Stop writers and follow restore recovery guidance",
  },
  "catalog-invalid": {
    code: "CATALOG_INTEGRITY_INVALID",
    component: "catalog",
    severity: "error",
    summary: "Catalog integrity verification failed",
    nextAction: "Restore a release-bound catalog before serving requests",
  },
  "advisory-invalid": {
    code: "ADVISORY_INTEGRITY_INVALID",
    component: "advisory",
    severity: "error",
    summary: "Advisory integrity verification failed",
    nextAction: "Restore the release-bound advisory chain",
  },
  "client-missing": {
    code: "CLIENT_MISSING",
    component: "codex",
    severity: "warning",
    summary: "A selected normal client is unavailable",
    nextAction: "Install a supported normal client and run repair",
  },
  "client-version-unsupported": {
    code: "CLIENT_VERSION_UNSUPPORTED",
    component: "codex",
    severity: "error",
    summary: "The selected normal client version is unsupported",
    nextAction: "Use a certified client version before repair",
  },
  "plugin-missing": {
    code: "PLUGIN_MISSING",
    component: "activation",
    severity: "warning",
    summary: "The owned activation plugin is absent",
    nextAction: "Preview an ownership-proven client repair",
  },
  "plugin-outdated": {
    code: "PLUGIN_OUTDATED",
    component: "activation",
    severity: "warning",
    summary: "The owned activation plugin is outdated",
    nextAction: "Preview an ownership-proven client repair",
  },
  "mcp-absent": {
    code: "MCP_CONFIGURATION_ABSENT",
    component: "mcp-contract",
    severity: "warning",
    summary: "The expected MCP registration is absent",
    nextAction: "Preview an ownership-proven client repair",
  },
  "mcp-conflicting": {
    code: "MCP_CONFIGURATION_CONFLICTING",
    component: "mcp-contract",
    severity: "error",
    summary: "An MCP registration conflicts with the expected identity",
    nextAction: "Resolve the external conflict outside SkillWire",
  },
  "mcp-duplicate": {
    code: "MCP_CONFIGURATION_DUPLICATE",
    component: "mcp-contract",
    severity: "error",
    summary: "The effective MCP registration is ambiguous",
    nextAction: "Remove the ambiguity outside SkillWire before repair",
  },
  "credential-unavailable": {
    code: "CREDENTIAL_UNAVAILABLE",
    component: "credential",
    severity: "warning",
    summary: "A client credential reference is unavailable",
    nextAction: "Run explicit client key rotation",
  },
  "authentication-rejected": {
    code: "AUTHENTICATION_REJECTED",
    component: "credential",
    severity: "error",
    summary: "The service rejected client authentication",
    nextAction: "Run explicit client key rotation",
  },
  "endpoint-unreachable": {
    code: "ENDPOINT_UNREACHABLE",
    component: "bridge",
    severity: "warning",
    summary: "The local MCP endpoint is unreachable",
    nextAction: "Restore service readiness or keep using the ordinary client",
  },
  "tool-contract-mismatch": {
    code: "TOOL_CONTRACT_MISMATCH",
    component: "mcp-contract",
    severity: "error",
    summary: "The six-tool contract does not match",
    nextAction: "Repair or upgrade the verified service and integration",
  },
  "activation-adapter-unavailable": {
    code: "ACTIVATION_ADAPTER_UNAVAILABLE",
    component: "activation",
    severity: "warning",
    summary: "The activation adapter is unavailable",
    nextAction: "Repair the owned plugin without changing normal startup",
  },
  "source-degraded": {
    code: "SOURCE_SYNCHRONIZATION_DEGRADED",
    component: "source",
    severity: "warning",
    summary: "An opted-in source is degraded",
    nextAction: "Keep verified cached content and retry source sync later",
  },
  "release-invalid": {
    code: "RELEASE_INTEGRITY_INVALID",
    component: "release",
    severity: "error",
    summary: "The installed release identity is invalid",
    nextAction: "Install a signed non-downgrade release",
  },
  "trust-policy-invalid": {
    code: "TRUST_POLICY_INVALID",
    component: "trust-policy",
    severity: "error",
    summary: "The active trust policy is invalid",
    nextAction: "Recover from a policy accepted by the current trust quorum",
  },
  "service-secret-unsafe": {
    code: "SERVICE_SECRET_UNSAFE",
    component: "service-secret",
    severity: "recovery-required",
    summary: "An owned service-secret file is unsafe",
    nextAction: "Stop the service and inspect the exact owned file",
  },
  "ownership-drifted": {
    code: "OWNERSHIP_DRIFTED",
    component: "ownership",
    severity: "recovery-required",
    summary: "An owned asset no longer matches its recorded identity",
    nextAction: "Resolve the drift without adopting external state",
  },
  "operation-locked": {
    code: "OPERATION_LOCKED",
    component: "concurrency",
    severity: "warning",
    summary: "A live administrative operation holds the installation lock",
    nextAction: "Wait for the live operation to finish",
  },
  "backup-invalid": {
    code: "BACKUP_INVALID",
    component: "backup",
    severity: "error",
    summary: "The retained backup failed validation",
    nextAction: "Create and restore-validate a new backup",
  },
  "journal-recovery-required": {
    code: "JOURNAL_RECOVERY_REQUIRED",
    component: "journal",
    severity: "recovery-required",
    summary: "An operation journal has an unproven effect",
    nextAction: "Run repair to observe and reconcile the last effect boundary",
  },
};

function safeEvidence(
  evidence: Readonly<Record<string, string | number | boolean | null>>,
): Record<string, string | number | boolean | null> {
  const redacted = redactOutput(evidence);
  if (
    redacted === null ||
    typeof redacted !== "object" ||
    Array.isArray(redacted)
  )
    throw new Error("Diagnostic evidence is invalid");
  return Object.fromEntries(Object.entries(redacted).slice(0, 16));
}

export function diagnosticProbe(
  condition: DiagnosticCondition,
  evidence: Readonly<Record<string, string | number | boolean | null>> = {},
): DiagnosticProbe {
  const classification = CLASSIFICATIONS[condition];
  return {
    id: condition,
    run: (signal) => {
      if (signal.aborted) throw new Error("Diagnostic inspection cancelled");
      return Promise.resolve(
        DiagnosticFindingSchema.parse({
          ...classification,
          evidence: safeEvidence(evidence),
        }),
      );
    },
  };
}

export async function runDiagnosticProbes(
  probes: readonly DiagnosticProbe[],
  signal: AbortSignal,
): Promise<readonly DiagnosticFinding[]> {
  const findings: DiagnosticFinding[] = [];
  for (const probe of probes) {
    if (signal.aborted) throw new Error("Diagnostic inspection cancelled");
    const finding = await probe.run(signal);
    if (finding !== null) findings.push(DiagnosticFindingSchema.parse(finding));
  }
  return findings;
}

export function degradedSourceProbe(choice: SourceChoice): DiagnosticProbe {
  if (
    !choice.selected ||
    (choice.syncState !== "degraded" && choice.syncState !== "failed")
  ) {
    return {
      id: `source:${choice.source}`,
      run: () => Promise.resolve(null),
    };
  }
  return {
    ...diagnosticProbe("source-degraded", {
      source: choice.source,
      syncState: choice.syncState,
      registered: choice.registrationIdentity !== null,
    }),
    id: `source:${choice.source}`,
  };
}
