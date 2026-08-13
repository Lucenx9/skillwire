import { randomUUID } from "node:crypto";

import {
  canonicalPreview,
  confirmPreview,
  exitCodeForClass,
} from "./confirmation.js";
import { AdminResultSchema, renderAdminResult } from "./output.js";
import type { DispatcherIo, ParsedCommand } from "./main.js";
import {
  ProductionSetupMutationError,
  previewProductionSetup,
  runProductionSetup,
} from "../application/production-setup.js";
import type { AdminResult, ExitClass } from "./output.js";

function emit(
  result: AdminResult,
  command: ParsedCommand,
  io: DispatcherIo,
): number {
  const rendered = renderAdminResult(result, command.output);
  if (command.output === "json") io.stdout(rendered);
  else io.stderr(rendered);
  return exitCodeForClass(result.exitClass);
}

function failureClass(error: unknown): ExitClass {
  const message = error instanceof Error ? error.message : "";
  if (/preview hash confirmation/i.test(message)) return "invalid-invocation";
  if (
    /release|manifest|cosign|sigstore|trustedroot|trust policy|archive identity/i.test(
      message,
    )
  ) {
    return "release-integrity-failure";
  }
  if (
    /docker|compose|postgres|migration|readiness|service|port/i.test(message)
  ) {
    return "service-failure";
  }
  if (/credential|secret service|key/i.test(message)) {
    return "credential-or-authentication-failure";
  }
  if (/codex|claude|client|mcp|plugin/i.test(message)) {
    return "client-contract-failure";
  }
  return "internal-failure";
}

export function setupFailureEnvelope(options: {
  readonly error: unknown;
  readonly operationId: string;
  readonly previewHash: string | null;
  readonly cancelled: boolean;
}): AdminResult {
  const mutated = options.error instanceof ProductionSetupMutationError;
  const exitClass = failureClass(options.error);
  return AdminResultSchema.parse({
    schemaVersion: "skillwire.admin-result/v1",
    command: "setup",
    operationId: options.operationId,
    status: options.cancelled
      ? "cancelled"
      : mutated
        ? "recovery-required"
        : "failure",
    exitClass: options.cancelled
      ? "user-cancellation"
      : mutated
        ? "rollback-required"
        : exitClass,
    previewHash: options.previewHash,
    changed: mutated,
    summary: mutated
      ? "Setup stopped after an owned installation mutation began"
      : "Setup stopped before a successful final state",
    components: [],
    findings: [
      {
        code: options.cancelled
          ? "SETUP_CANCELLED"
          : mutated
            ? "SETUP_RECOVERY_REQUIRED"
            : "SETUP_FAILED",
        severity: mutated ? "recovery-required" : "error",
        component: "setup",
        summary:
          options.error instanceof Error
            ? options.error.message.slice(0, 512)
            : "Setup failed",
        nextAction: mutated
          ? "Inspect the owned installation operation journal before retrying"
          : "Resolve the reported condition and generate a fresh preview",
      },
    ],
    recovery: {
      rollbackBoundary: mutated ? "application-config" : "none",
      backupId: null,
      instructions: [],
    },
  });
}

async function routeSetup(
  command: ParsedCommand,
  io: DispatcherIo,
  signal: AbortSignal,
): Promise<number> {
  const operationId = randomUUID();
  let previewHash: string | null = null;
  if ((command.sources?.length ?? 0) > 0) {
    return emit(
      AdminResultSchema.parse({
        schemaVersion: "skillwire.admin-result/v1",
        command: "setup",
        operationId,
        status: "failure",
        exitClass: "unsupported-prerequisite",
        previewHash: null,
        changed: false,
        summary:
          "External source bootstrap is outside the Feature 004 technical MVP",
        components: [],
        findings: [
          {
            code: "SOURCE_BOOTSTRAP_NOT_AVAILABLE",
            severity: "error",
            component: "source",
            summary: "No source registration was attempted",
            nextAction: "Run setup without --source",
          },
        ],
        recovery: {
          rollbackBoundary: "none",
          backupId: null,
          instructions: [],
        },
      }),
      command,
      io,
    );
  }
  try {
    const selection = command.clients ?? "none";
    const scope = await previewProductionSetup({ clients: selection });
    const preview = canonicalPreview("setup", scope);
    previewHash = preview.hash;
    if (command.previewOnly) {
      return emit(
        AdminResultSchema.parse({
          schemaVersion: "skillwire.admin-result/v1",
          command: "setup",
          operationId,
          status: "preview",
          exitClass: "success",
          previewHash: preview.hash,
          changed: false,
          summary: "Validated signed-release setup preview",
          components: [
            {
              component: "release",
              state: "verified-candidate",
              changed: false,
              owned: false,
              identity: {
                releaseVersion: scope.releaseVersion,
                architecture: scope.architecture,
              },
            },
            {
              component: "credential",
              state: scope.credentialBackend,
              changed: false,
              owned: false,
              identity: {
                fallbackConfirmed: scope.fallbackRiskConfirmedByThisPreview,
              },
            },
          ],
          findings: [],
          recovery: {
            rollbackBoundary: "client-only",
            backupId: null,
            instructions: [],
          },
        }),
        command,
        io,
      );
    }
    confirmPreview(preview, command.confirmPreview);
    const result = await runProductionSetup(
      {
        clients: selection,
        credentialBackend: scope.credentialBackend,
        previewHash: preview.hash,
      },
      signal,
    );
    const exitClass: ExitClass =
      result.status === "success"
        ? "success"
        : result.status === "incomplete"
          ? "degraded-or-incomplete"
          : "rollback-required";
    return emit(
      AdminResultSchema.parse({
        schemaVersion: "skillwire.admin-result/v1",
        command: "setup",
        operationId,
        status: result.status,
        exitClass,
        previewHash: preview.hash,
        changed: true,
        summary:
          selection === "none" && result.status === "success"
            ? "Self-hosted service is ready; client integration remains pending"
            : `Self-hosted setup finished with status ${result.status}`,
        components: [
          {
            component: "service",
            state: result.serviceReady ? "ready" : "failed",
            changed: true,
            owned: true,
            identity: { installationId: result.installationId },
          },
          ...result.clients.map((client) => ({
            component: client.client,
            state: client.status,
            changed: client.status === "verified" && client.owned !== false,
            owned: client.status === "verified" && client.owned !== false,
            identity: {
              compensated: client.compensated,
              external: client.status === "external-verified",
            },
          })),
        ],
        findings: result.clients
          .filter(
            (client) =>
              client.status !== "verified" &&
              client.status !== "external-verified",
          )
          .map((client) =>
            client.conflict === undefined
              ? {
                  code: `${client.client.toUpperCase()}_INSTALLATION_INCOMPLETE`,
                  severity:
                    client.status === "recovery-required"
                      ? ("recovery-required" as const)
                      : ("error" as const),
                  component: client.client,
                  summary: `${client.client} deterministic verification did not complete`,
                  nextAction:
                    "Review the client-specific recovery summary and retry after resolution",
                }
              : {
                  code: client.conflict.code,
                  severity: "error" as const,
                  component: client.client,
                  summary: `${client.client} ${client.conflict.component} is ${client.conflict.classification} at ${client.conflict.scope} scope (${client.conflict.identitySha256})`,
                  nextAction:
                    "Resolve the external client or managed-policy conflict outside SkillWire, then retry",
                },
          ),
        recovery: {
          rollbackBoundary:
            result.status === "success" ? "none" : "client-only",
          backupId: null,
          instructions: [],
        },
      }),
      command,
      io,
    );
  } catch (error) {
    return emit(
      setupFailureEnvelope({
        error,
        operationId,
        previewHash,
        cancelled: signal.aborted,
      }),
      command,
      io,
    );
  }
}

export async function routeAdministrativeCommand(
  command: ParsedCommand,
  io: DispatcherIo,
  signal: AbortSignal,
): Promise<number> {
  if (signal.aborted) return 11;
  if (
    command.stateRoot !== undefined &&
    process.env["SKILLWIRE_ALLOW_STATE_ROOT"] !== "test"
  ) {
    io.stderr("--state-root is restricted to isolated tests and diagnostics\n");
    return 2;
  }
  if (command.route === "setup") return routeSetup(command, io, signal);
  const result = AdminResultSchema.parse({
    schemaVersion: "skillwire.admin-result/v1",
    command: command.route,
    operationId: randomUUID(),
    status: "failure",
    exitClass: "unsupported-prerequisite",
    previewHash: null,
    changed: false,
    summary:
      "This lifecycle route is reserved for a later Feature 004 slice and made no change",
    components: [],
    findings: [],
    recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
  });
  return emit(result, command, io);
}
