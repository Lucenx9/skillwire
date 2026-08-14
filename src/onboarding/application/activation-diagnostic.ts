import type { ClientName } from "../cli/main.js";

export interface ActivationDiagnosticResult {
  readonly client: ClientName;
  readonly status: "invoked" | "not-invoked" | "failed";
  readonly attempts: 1;
  readonly changedInstallationState: false;
  readonly summary: string;
}

export async function runActivationDiagnostic(
  client: ClientName,
  runFreshOrdinarySession: () => Promise<"invoked" | "not-invoked">,
): Promise<ActivationDiagnosticResult> {
  try {
    const status = await runFreshOrdinarySession();
    return {
      client,
      status,
      attempts: 1,
      changedInstallationState: false,
      summary:
        status === "invoked"
          ? "Automatic activation produced attributable evidence"
          : "Automatic activation was not observed; deterministic installation remains verified",
    };
  } catch {
    return {
      client,
      status: "failed",
      attempts: 1,
      changedInstallationState: false,
      summary:
        "Automatic activation diagnostic failed without changing installation state",
    };
  }
}
