import type { ClientName } from "../cli/main.js";
import type { ClientComponentClassification } from "../adapters/clients/client-state.js";
import { ClientMutationNotStartedError } from "../domain/client-mutation.js";
import {
  captureProfileSnapshot,
  profileMatchesSnapshotBefore,
  recordExpectedProfilePostImage,
  restoreProfileSnapshot,
  type CaptureProfileSnapshotOptions,
  type ProtectedProfileSnapshot,
} from "../domain/profile-snapshot.js";

export type ClientComponentAction = "create" | "reuse-owned" | "reuse-external";

export type ClientPreflightDecision =
  | {
      readonly action: "proceed" | "reuse-external";
      readonly mcp: ClientComponentAction;
      readonly plugin: ClientComponentAction;
    }
  | {
      readonly action: "block";
      readonly classification: Exclude<
        ClientComponentClassification,
        "absent" | "owned-equivalent" | "external-equivalent"
      >;
      readonly finding?: ClientConflictFinding | undefined;
    };

export interface ClientLifecycleDependencies {
  preflight(): Promise<ClientPreflightDecision> | Promise<void>;
  provisionCredential(): Promise<{
    readonly keyId: string;
    readonly reference: string;
  }>;
  addMcp(): Promise<void>;
  addPlugin(): Promise<void>;
  verify(): Promise<void>;
  removePlugin(): Promise<void>;
  removeMcp(): Promise<void>;
  revokeCredential(keyId: string, reference: string): Promise<void>;
  readonly profileSnapshot?: CaptureProfileSnapshotOptions | undefined;
}

export interface ClientLifecycleResult {
  readonly client: ClientName;
  readonly status:
    "verified" | "external-verified" | "failed" | "recovery-required";
  readonly compensated: boolean;
  readonly owned: boolean;
  readonly components: {
    readonly credential: "created" | "none";
    readonly mcp: "created" | "owned" | "external" | "none";
    readonly plugin: "created" | "owned" | "external" | "none";
  };
  readonly summary: string;
  readonly snapshotId?: string | undefined;
  readonly conflict?: ClientConflictFinding | undefined;
}

export type ClientLifecycleOperation =
  "setup" | "repair" | "upgrade" | "uninstall" | "purge";

export function evaluateClientLifecycleAction(
  _operation: ClientLifecycleOperation,
  classification: ClientComponentClassification,
): {
  readonly action: "mutate" | "reuse-external" | "no-op" | "block";
  readonly mutable: boolean;
} {
  if (classification === "external-equivalent")
    return { action: "reuse-external", mutable: false };
  if (
    classification === "absent" &&
    (_operation === "uninstall" || _operation === "purge")
  )
    return { action: "no-op", mutable: false };
  if (classification === "absent" || classification === "owned-equivalent")
    return { action: "mutate", mutable: true };
  return { action: "block", mutable: false };
}

export interface ClientConflictFinding {
  readonly code: "CLIENT_INTEGRATION_CONFLICT";
  readonly client: ClientName;
  readonly component: "mcp-entry" | "plugin" | "marketplace";
  readonly classification: ClientComponentClassification;
  readonly scope: string;
  readonly identitySha256: string;
}

export function clientConflictFinding(
  client: ClientName,
  component: ClientConflictFinding["component"],
  classification: ClientComponentClassification,
  observation: { readonly scope: string; readonly identitySha256: string },
): ClientConflictFinding {
  if (!/^[0-9a-f]{64}$/.test(observation.identitySha256))
    throw new Error("Client conflict identity is invalid");
  return {
    code: "CLIENT_INTEGRATION_CONFLICT",
    client,
    component,
    classification,
    scope: observation.scope,
    identitySha256: observation.identitySha256,
  };
}

export class ClientProvisioningRecoveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ClientProvisioningRecoveryError";
  }
}

export async function installClientLifecycle(
  client: ClientName,
  dependencies: ClientLifecycleDependencies,
): Promise<ClientLifecycleResult> {
  let credential:
    { readonly keyId: string; readonly reference: string } | undefined;
  let mcpMutationAttempted = false;
  let pluginMutationAttempted = false;
  let plannedComponents: ClientLifecycleResult["components"] = {
    credential: "none",
    mcp: "none",
    plugin: "none",
  };
  let snapshot: ProtectedProfileSnapshot | undefined;
  try {
    const decision = (await dependencies.preflight()) ?? {
      action: "proceed" as const,
      mcp: "create" as const,
      plugin: "create" as const,
    };
    if (decision.action === "block") {
      return {
        client,
        status: "failed",
        compensated: false,
        owned: false,
        components: plannedComponents,
        summary: `${client} native integration is blocked by existing client state`,
        ...(decision.finding === undefined
          ? {}
          : { conflict: decision.finding }),
      };
    }
    const createsMcp = decision.mcp === "create";
    const createsPlugin = decision.plugin === "create";
    const ownsAny =
      decision.mcp === "reuse-owned" ||
      decision.plugin === "reuse-owned" ||
      createsMcp ||
      createsPlugin;
    plannedComponents = {
      credential: createsMcp ? "created" : "none",
      mcp:
        decision.mcp === "create"
          ? "created"
          : decision.mcp === "reuse-owned"
            ? "owned"
            : "external",
      plugin:
        decision.plugin === "create"
          ? "created"
          : decision.plugin === "reuse-owned"
            ? "owned"
            : "external",
    };
    if (
      (createsMcp || createsPlugin) &&
      dependencies.profileSnapshot !== undefined
    ) {
      snapshot = await captureProfileSnapshot(dependencies.profileSnapshot);
    }
    if (createsMcp) credential = await dependencies.provisionCredential();
    if (createsMcp) {
      mcpMutationAttempted = true;
      await dependencies.addMcp();
    }
    if (createsPlugin) {
      pluginMutationAttempted = true;
      await dependencies.addPlugin();
    }
    if (snapshot !== undefined)
      snapshot = await recordExpectedProfilePostImage(snapshot);
    await dependencies.verify();
    return {
      client,
      status: ownsAny ? "verified" : "external-verified",
      compensated: false,
      owned: ownsAny,
      components: plannedComponents,
      summary: `${client} native integration verified`,
      ...(snapshot === undefined ? {} : { snapshotId: snapshot.snapshotId }),
    };
  } catch (error) {
    if (error instanceof ClientMutationNotStartedError) {
      if (error.stage === "mcp") mcpMutationAttempted = false;
      if (error.stage === "plugin") pluginMutationAttempted = false;
    }
    let compensationFailed = error instanceof ClientProvisioningRecoveryError;
    if (
      snapshot?.entries.some(
        ({ expectedPostIdentity }) => expectedPostIdentity === undefined,
      )
    ) {
      try {
        snapshot = await recordExpectedProfilePostImage(snapshot);
      } catch {
        compensationFailed = true;
      }
    }
    if (pluginMutationAttempted)
      await dependencies
        .removePlugin()
        .catch(() => (compensationFailed = true));
    if (mcpMutationAttempted)
      await dependencies.removeMcp().catch(() => (compensationFailed = true));
    if (credential !== undefined) {
      await dependencies
        .revokeCredential(credential.keyId, credential.reference)
        .catch(() => (compensationFailed = true));
    }
    if (
      snapshot !== undefined &&
      !(await profileMatchesSnapshotBefore(snapshot).catch(() => false))
    ) {
      const restored = await restoreProfileSnapshot(snapshot).catch(
        () => undefined,
      );
      if (restored?.restorationState !== "restored") compensationFailed = true;
    }
    return compensationFailed
      ? {
          client,
          status: "recovery-required",
          compensated: false,
          owned:
            credential !== undefined ||
            mcpMutationAttempted ||
            pluginMutationAttempted,
          components: plannedComponents,
          summary: `${client} installation failed and narrow compensation needs recovery`,
          ...(snapshot === undefined
            ? {}
            : { snapshotId: snapshot.snapshotId }),
        }
      : {
          client,
          status: "failed",
          compensated: true,
          owned: false,
          components: {
            credential: "none",
            mcp: "none",
            plugin: "none",
          },
          summary: `${client} installation failed and was compensated`,
          ...(snapshot === undefined
            ? {}
            : { snapshotId: snapshot.snapshotId }),
        };
  }
}
