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
import { inspectInstalledStatus } from "../application/status.js";
import {
  bootstrapProductionSources,
  ProductionSourceBootstrapError,
  readProductionSourceDeployment,
} from "../application/source-bootstrap.js";
import { readBoundedGitHubToken } from "../adapters/credentials/github-token.js";
import { JournaledOperationFailure } from "../domain/operation-journal.js";
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

export type AdministrativeOperation = (
  command: ParsedCommand,
  signal: AbortSignal,
) => Promise<AdminResult>;

export type AdministrativeOperations = Partial<
  Readonly<Record<ParsedCommand["route"], AdministrativeOperation>>
>;

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

function signalIsAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function installationStateIsAbsent(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("code" in error && error.code === "ENOENT") ||
      error.message.includes("ENOENT"))
  );
}

export function setupFailureEnvelope(options: {
  readonly error: unknown;
  readonly operationId: string;
  readonly previewHash: string | null;
  readonly cancelled: boolean;
  readonly changed?: boolean | undefined;
}): AdminResult {
  const mutated = options.error instanceof ProductionSetupMutationError;
  const changed = options.changed === true || mutated;
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
    changed,
    summary: changed
      ? mutated
        ? "Setup stopped after an owned installation mutation began"
        : "Setup stopped after reaching a persisted safe boundary"
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
  let setupChanged = false;
  try {
    const selection = command.clients ?? "none";
    const scope = await previewProductionSetup(
      { clients: selection, sources: command.sources ?? [] },
      process.env,
      {},
      signal,
    );
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
          previewScope: scope,
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
    const setupResult = await runProductionSetup(
      {
        clients: selection,
        sources: command.sources ?? [],
        credentialBackend: scope.credentialBackend,
        previewHash: preview.hash,
      },
      signal,
    );
    setupChanged = setupResult.changed !== false;
    let sourceChoices = setupResult.sources ?? [];
    let sourceChanged = false;
    if ((command.sources?.length ?? 0) > 0 && setupResult.serviceReady) {
      const stateHome =
        process.env["XDG_STATE_HOME"] ??
        `${process.env["HOME"] ?? ""}/.local/state`;
      const stateRoot = `${stateHome}/skillwire`;
      const runtimeRoot = `${process.env["XDG_RUNTIME_DIR"] ?? `/run/user/${String(process.getuid?.() ?? 0)}`}/skillwire`;
      let token: string | undefined;
      if (!process.stdin.isTTY) {
        try {
          token = await readBoundedGitHubToken(process.stdin, signal);
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
      const bootstrapped = await bootstrapProductionSources({
        selected: command.sources ?? [],
        deployment: await readProductionSourceDeployment(stateRoot),
        stateRoot,
        runtimeRoot,
        environment: process.env,
        ...(token === undefined ? {} : { token }),
        signal,
        operationId,
      });
      sourceChoices = bootstrapped.choices;
      sourceChanged = bootstrapped.changed;
    }
    const sourceIncomplete = sourceChoices.some(
      ({ selected, syncState }) =>
        selected && (syncState === "degraded" || syncState === "failed"),
    );
    const clientIncomplete = setupResult.clients.some(
      ({ status }) => status !== "verified" && status !== "external-verified",
    );
    const result = {
      ...setupResult,
      status:
        setupResult.status === "recovery-required"
          ? setupResult.status
          : sourceIncomplete
            ? ("incomplete" as const)
            : setupResult.status,
      sources: sourceChoices,
      changed: setupResult.changed !== false || sourceChanged,
    };
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
        changed: result.changed,
        summary: sourceIncomplete
          ? "Self-hosted service is ready; an optional source remains degraded"
          : selection === "none" && result.status === "success"
            ? "Self-hosted service is ready; client integration remains pending"
            : `Self-hosted setup finished with status ${result.status}`,
        components: [
          {
            component: "service",
            state: result.serviceReady ? "ready" : "failed",
            changed: setupResult.changed !== false,
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
          ...result.sources
            .filter(({ selected }) => selected)
            .map((source) => ({
              component: "source",
              state: source.syncState,
              changed: sourceChanged,
              owned: false,
              identity: {
                source: source.source,
                registered: source.registrationIdentity !== null,
              },
            })),
        ],
        findings: [
          ...result.clients
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
          ...result.sources
            .filter(
              ({ selected, syncState }) =>
                selected &&
                (syncState === "degraded" || syncState === "failed"),
            )
            .map((source) => ({
              code:
                source.syncState === "degraded"
                  ? "SOURCE_SYNCHRONIZATION_DEGRADED"
                  : "SOURCE_BOOTSTRAP_FAILED",
              severity: "warning" as const,
              component: "source",
              summary: `${source.source} did not become eligible; first-party service remains ready`,
              nextAction:
                source.credentialReferenceId === null
                  ? "Pipe one separate read-only GitHub token on stdin and retry the same confirmed setup"
                  : "Keep eligible cached content and retry source synchronization later",
            })),
        ],
        recovery: {
          rollbackBoundary:
            result.status === "success" || !clientIncomplete
              ? "none"
              : "client-only",
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
        changed:
          setupChanged ||
          (error instanceof ProductionSourceBootstrapError && error.changed),
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
  operations: AdministrativeOperations = {},
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
  if (command.route === "status" && operations.status !== undefined) {
    try {
      return emit(await operations.status(command, signal), command, io);
    } catch (error) {
      const absent = installationStateIsAbsent(error);
      return emit(
        AdminResultSchema.parse({
          schemaVersion: "skillwire.admin-result/v1",
          command: "status",
          operationId: randomUUID(),
          status: signalIsAborted(signal) ? "cancelled" : "failure",
          exitClass: signalIsAborted(signal)
            ? "user-cancellation"
            : absent
              ? "unsupported-prerequisite"
              : "degraded-or-incomplete",
          previewHash: null,
          changed: false,
          summary: "Installed and live state could not be inspected safely",
          components: [],
          findings: [
            {
              code: "STATUS_STATE_UNAVAILABLE",
              severity: "error",
              component: "installation",
              summary: absent
                ? "No SkillWire installation state exists in this profile"
                : error instanceof Error
                  ? error.message.slice(0, 512)
                  : "Installed state is unavailable",
              nextAction: absent
                ? "Run setup to create a verified self-hosted installation"
                : "Run doctor to classify the installed-state failure",
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
  }
  if (command.route === "status") {
    const stateHome =
      process.env["XDG_STATE_HOME"] ??
      `${process.env["HOME"] ?? ""}/.local/state`;
    const stateRoot = command.stateRoot ?? `${stateHome}/skillwire`;
    try {
      const status = await inspectInstalledStatus({ stateRoot, signal });
      return emit(
        AdminResultSchema.parse({
          schemaVersion: "skillwire.admin-result/v1",
          command: "status",
          operationId: randomUUID(),
          status: "success",
          exitClass: "success",
          previewHash: null,
          changed: false,
          summary: `Installation state is ${status.installation.status}`,
          components: [
            {
              component: "installation",
              state: status.installation.status,
              changed: false,
              owned: true,
              identity: {
                installationId: status.installation.installationId,
                release: status.installation.activeReleaseId,
              },
            },
            ...status.live.map((component) => ({
              component: component.component,
              state: component.state,
              changed: false,
              owned: true,
              identity: component.identity ?? {},
            })),
          ],
          findings: [],
          recovery: {
            rollbackBoundary: "none",
            backupId: null,
            instructions: [],
          },
        }),
        command,
        io,
      );
    } catch (error) {
      return emit(
        AdminResultSchema.parse({
          schemaVersion: "skillwire.admin-result/v1",
          command: "status",
          operationId: randomUUID(),
          status: signalIsAborted(signal) ? "cancelled" : "failure",
          exitClass: signalIsAborted(signal)
            ? "user-cancellation"
            : "degraded-or-incomplete",
          previewHash: null,
          changed: false,
          summary: "Installed state could not be inspected safely",
          components: [],
          findings: [
            {
              code: "STATUS_STATE_UNAVAILABLE",
              severity: "error",
              component: "installation",
              summary:
                error instanceof Error
                  ? error.message.slice(0, 512)
                  : "Installed state is unavailable",
              nextAction: "Run doctor to classify the installed-state failure",
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
  }
  const operation = operations[command.route];
  if (operation !== undefined) {
    try {
      return emit(await operation(command, signal), command, io);
    } catch (error) {
      const mutated = error instanceof JournaledOperationFailure;
      const cancelled = signalIsAborted(signal);
      return emit(
        AdminResultSchema.parse({
          schemaVersion: "skillwire.admin-result/v1",
          command: command.route,
          operationId: randomUUID(),
          status: cancelled
            ? "cancelled"
            : mutated
              ? "recovery-required"
              : "failure",
          exitClass: cancelled
            ? "user-cancellation"
            : mutated
              ? "rollback-required"
              : failureClass(error),
          previewHash: null,
          changed: mutated,
          summary: mutated
            ? `${command.route} stopped after an owned mutation began`
            : `${command.route} stopped before successful completion`,
          components: [],
          findings: [
            {
              code: mutated
                ? "LIFECYCLE_RECOVERY_REQUIRED"
                : "LIFECYCLE_OPERATION_FAILED",
              severity: mutated ? "recovery-required" : "error",
              component: command.route,
              summary:
                error instanceof Error
                  ? error.message.slice(0, 512)
                  : "Lifecycle operation failed",
              nextAction: mutated
                ? "Inspect and recover the owned operation journal before retrying"
                : "Resolve the reported condition and generate a fresh preview",
            },
          ],
          recovery: {
            rollbackBoundary: mutated ? error.rollbackBoundary : "none",
            backupId: null,
            instructions: [],
          },
        }),
        command,
        io,
      );
    }
  }
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
