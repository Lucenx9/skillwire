import { redactText } from "../onboarding/cli/output.js";

export const BRIDGE_FAILURE_CODES = [
  "BRIDGE_STATE_UNAVAILABLE",
  "BRIDGE_ENDPOINT_INVALID",
  "BRIDGE_CREDENTIAL_UNAVAILABLE",
  "BRIDGE_AUTH_REJECTED",
  "BRIDGE_CONTRACT_INVALID",
  "BRIDGE_DEADLINE_EXCEEDED",
  "BRIDGE_CANCELLED",
  "BRIDGE_TRANSPORT_UNAVAILABLE",
] as const;

export type BridgeFailureCode = (typeof BRIDGE_FAILURE_CODES)[number];
export type BridgeFailureKind =
  | "state"
  | "endpoint"
  | "credential"
  | "auth"
  | "contract"
  | "timeout"
  | "cancellation"
  | "transport";

const codeForKind: Readonly<Record<BridgeFailureKind, BridgeFailureCode>> = {
  state: "BRIDGE_STATE_UNAVAILABLE",
  endpoint: "BRIDGE_ENDPOINT_INVALID",
  credential: "BRIDGE_CREDENTIAL_UNAVAILABLE",
  auth: "BRIDGE_AUTH_REJECTED",
  contract: "BRIDGE_CONTRACT_INVALID",
  timeout: "BRIDGE_DEADLINE_EXCEEDED",
  cancellation: "BRIDGE_CANCELLED",
  transport: "BRIDGE_TRANSPORT_UNAVAILABLE",
};

const messageForCode: Readonly<Record<BridgeFailureCode, string>> = {
  BRIDGE_STATE_UNAVAILABLE: "SkillWire bridge state is unavailable",
  BRIDGE_ENDPOINT_INVALID: "SkillWire bridge endpoint is invalid",
  BRIDGE_CREDENTIAL_UNAVAILABLE: "SkillWire bridge credential is unavailable",
  BRIDGE_AUTH_REJECTED: "SkillWire bridge authentication was rejected",
  BRIDGE_CONTRACT_INVALID: "SkillWire bridge contract validation failed",
  BRIDGE_DEADLINE_EXCEEDED: "SkillWire bridge startup deadline exceeded",
  BRIDGE_CANCELLED: "SkillWire bridge startup was cancelled",
  BRIDGE_TRANSPORT_UNAVAILABLE: "SkillWire bridge transport is unavailable",
};

export class BridgeFailure extends Error {
  public constructor(
    readonly code: BridgeFailureCode,
    options?: ErrorOptions,
  ) {
    super(messageForCode[code], options);
    this.name = "BridgeFailure";
  }
}

export function normalizeBridgeFailure(
  error: unknown,
  kind: BridgeFailureKind = "transport",
): BridgeFailure {
  if (error instanceof BridgeFailure) return error;
  if (kind === "transport" && error instanceof Error) {
    if (/(?:timeout|timed out|deadline)/i.test(error.message)) kind = "timeout";
    else if (/(?:401|403|unauthori[sz]ed|authentication)/i.test(error.message))
      kind = "auth";
    else if (
      /(?:protocol|contract|tool metadata|instructions)/i.test(error.message)
    )
      kind = "contract";
  }
  return new BridgeFailure(codeForKind[kind], { cause: error });
}

export interface BridgeFailureReport {
  readonly code: BridgeFailureCode;
  readonly message: string;
  readonly retry: false;
  readonly prompt: false;
  readonly failOpen: true;
}

export function bridgeFailureReport(error: BridgeFailure): BridgeFailureReport {
  return {
    code: error.code,
    message: redactText(messageForCode[error.code]),
    retry: false,
    prompt: false,
    failOpen: true,
  };
}

export function bridgeMcpError(
  error: unknown,
  kind: BridgeFailureKind = "transport",
): Error {
  const failure = normalizeBridgeFailure(error, kind);
  return new Error(`${failure.code}: ${messageForCode[failure.code]}`);
}
