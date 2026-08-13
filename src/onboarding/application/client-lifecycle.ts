import type { ClientName } from "../cli/main.js";
import { ClientMutationNotStartedError } from "../domain/client-mutation.js";

export interface ClientLifecycleDependencies {
  preflight(): Promise<void>;
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
}

export interface ClientLifecycleResult {
  readonly client: ClientName;
  readonly status: "verified" | "failed" | "recovery-required";
  readonly compensated: boolean;
  readonly summary: string;
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
  try {
    await dependencies.preflight();
    credential = await dependencies.provisionCredential();
    mcpMutationAttempted = true;
    await dependencies.addMcp();
    pluginMutationAttempted = true;
    await dependencies.addPlugin();
    await dependencies.verify();
    return {
      client,
      status: "verified",
      compensated: false,
      summary: `${client} native integration verified`,
    };
  } catch (error) {
    if (error instanceof ClientMutationNotStartedError) {
      if (error.stage === "mcp") mcpMutationAttempted = false;
      if (error.stage === "plugin") pluginMutationAttempted = false;
    }
    let compensationFailed = error instanceof ClientProvisioningRecoveryError;
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
    return compensationFailed
      ? {
          client,
          status: "recovery-required",
          compensated: false,
          summary: `${client} installation failed and narrow compensation needs recovery`,
        }
      : {
          client,
          status: "failed",
          compensated: true,
          summary: `${client} installation failed and was compensated`,
        };
  }
}
