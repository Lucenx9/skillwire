import type { ClientName } from "../cli/main.js";
import type { BootstrapSource } from "../domain/source-choice.js";
import type { SourceChoice } from "../domain/source-choice.js";
import type { ClientConflictFinding } from "./client-lifecycle.js";

export interface GuidedSetupOptions {
  readonly clients: "none" | "codex" | "claude" | "codex,claude";
  readonly sources?: readonly BootstrapSource[] | undefined;
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
  inspectExisting?(
    options: GuidedSetupOptions,
  ): Promise<GuidedSetupResult | undefined>;
  discoverRetained?(
    options: GuidedSetupOptions,
  ): Promise<RetainedSetupState | undefined>;
  reactivateRetainedService?(
    release: { readonly releaseSequence: number },
    retained: RetainedSetupState,
  ): Promise<{ readonly ready: boolean }>;
  reactivateClient?(
    client: ClientName,
    installationId: string,
  ): Promise<SetupClientResult>;
  verifyRelease(): Promise<{ readonly releaseSequence: number }>;
  installService(release: { readonly releaseSequence: number }): Promise<{
    readonly installationId: string;
    readonly ready: boolean;
  }>;
  installClient(
    client: ClientName,
    installationId: string,
  ): Promise<SetupClientResult>;
  bootstrapSources?(selected: readonly BootstrapSource[]): Promise<{
    readonly choices: readonly SourceChoice[];
    readonly changed: boolean;
  }>;
}

export interface RetainedSetupState {
  readonly installationId: string;
  readonly clients: readonly SetupClientResult[];
}

export interface GuidedSetupResult {
  readonly status: "success" | "incomplete" | "recovery-required";
  readonly installationId: string;
  readonly serviceReady: boolean;
  readonly clients: readonly SetupClientResult[];
  readonly sources?: readonly SourceChoice[] | undefined;
  readonly changed?: boolean | undefined;
}

async function withSources(
  options: GuidedSetupOptions,
  dependencies: GuidedSetupDependencies,
  result: GuidedSetupResult,
): Promise<GuidedSetupResult> {
  const selected = options.sources ?? [];
  if (selected.length === 0) return result;
  if (dependencies.bootstrapSources === undefined)
    throw new Error("Explicit source bootstrap is unavailable");
  if (!result.serviceReady)
    throw new Error("Sources cannot bootstrap before service readiness");
  const bootstrapped = await dependencies.bootstrapSources(selected);
  const degraded = bootstrapped.choices.some(
    ({ selected: chosen, syncState }) =>
      chosen && (syncState === "degraded" || syncState === "failed"),
  );
  return {
    ...result,
    status:
      result.status === "recovery-required"
        ? result.status
        : degraded
          ? "incomplete"
          : result.status,
    sources: bootstrapped.choices,
    changed: result.changed !== false || bootstrapped.changed,
  };
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
  const existing = await dependencies.inspectExisting?.(options);
  if (existing !== undefined)
    return withSources(options, dependencies, existing);
  const release = await dependencies.verifyRelease();
  const retained = await dependencies.discoverRetained?.(options);
  if (retained !== undefined) {
    if (dependencies.reactivateRetainedService === undefined)
      throw new Error("Retained installation reactivation is unavailable");
    const service = await dependencies.reactivateRetainedService(
      release,
      retained,
    );
    if (!service.ready)
      throw new Error("Retained service did not reach readiness");
    const clients: SetupClientResult[] = [];
    for (const client of selectedClients(options.clients)) {
      const current = retained.clients.find(
        (entry) =>
          entry.client === client &&
          (entry.status === "verified" || entry.status === "external-verified"),
      );
      clients.push(
        current ??
          (await (dependencies.reactivateClient ?? dependencies.installClient)(
            client,
            retained.installationId,
          )),
      );
    }
    const status = clients.some(
      ({ status: clientStatus }) => clientStatus === "recovery-required",
    )
      ? "recovery-required"
      : clients.some(
            ({ status: clientStatus }) =>
              clientStatus !== "verified" &&
              clientStatus !== "external-verified",
          )
        ? "incomplete"
        : "success";
    return withSources(options, dependencies, {
      status,
      installationId: retained.installationId,
      serviceReady: true,
      clients,
    });
  }
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
  return withSources(options, dependencies, {
    status,
    installationId: service.installationId,
    serviceReady: true,
    clients,
  });
}
