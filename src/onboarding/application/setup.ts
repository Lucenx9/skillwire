import type { ClientName } from "../cli/main.js";
import type { ClientConflictFinding } from "./client-lifecycle.js";

export interface GuidedSetupOptions {
  readonly clients: "none" | "codex" | "claude" | "codex,claude";
}

export interface SetupClientResult {
  readonly client: ClientName;
  readonly status:
    "verified" | "external-verified" | "failed" | "recovery-required";
  readonly compensated: boolean;
  readonly owned?: boolean;
  readonly conflict?: ClientConflictFinding | undefined;
}

export interface GuidedSetupDependencies {
  verifyRelease(): Promise<{ readonly releaseSequence: number }>;
  installService(release: { readonly releaseSequence: number }): Promise<{
    readonly installationId: string;
    readonly ready: boolean;
  }>;
  installClient(
    client: ClientName,
    installationId: string,
  ): Promise<SetupClientResult>;
}

export interface GuidedSetupResult {
  readonly status: "success" | "incomplete" | "recovery-required";
  readonly installationId: string;
  readonly serviceReady: boolean;
  readonly clients: readonly SetupClientResult[];
}

function selectedClients(
  selection: GuidedSetupOptions["clients"],
): readonly ClientName[] {
  if (selection === "none") return [];
  if (selection === "codex,claude") return ["codex", "claude"];
  return [selection];
}

export async function runGuidedSetup(
  options: GuidedSetupOptions,
  dependencies: GuidedSetupDependencies,
): Promise<GuidedSetupResult> {
  const release = await dependencies.verifyRelease();
  const service = await dependencies.installService(release);
  if (!service.ready)
    throw new Error("Signed-release service did not reach readiness");
  const clients: SetupClientResult[] = [];
  for (const client of selectedClients(options.clients)) {
    clients.push(
      await dependencies.installClient(client, service.installationId),
    );
  }
  const status = clients.some(
    ({ status: clientStatus }) => clientStatus === "recovery-required",
  )
    ? "recovery-required"
    : clients.some(
          ({ status: clientStatus }) =>
            clientStatus !== "verified" && clientStatus !== "external-verified",
        )
      ? "incomplete"
      : "success";
  return {
    status,
    installationId: service.installationId,
    serviceReady: true,
    clients,
  };
}
