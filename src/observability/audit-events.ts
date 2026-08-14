import type { SkillWireErrorCode } from "../application/errors.js";

export type SecurityEventName =
  | "authentication_failed"
  | "request_rejected"
  | "request_rate_limited"
  | "tool_failed"
  | "github_discovery_completed"
  | "github_sync_completed"
  | "github_ingestion_rejected"
  | "github_lease_lost"
  | "service_started"
  | "service_stopped";

export interface SecurityEventFields {
  readonly requestId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly apiKeyId?: string | undefined;
  readonly code?: SkillWireErrorCode | undefined;
  readonly tool?: string | undefined;
  readonly status?: number | undefined;
  readonly sourceId?: string | undefined;
  readonly runId?: string | undefined;
  readonly candidateId?: string | undefined;
  readonly state?: string | undefined;
  readonly reasonCode?: string | undefined;
  readonly fencingToken?: number | undefined;
  readonly count?: number | undefined;
}

const SAFE_TOOL_NAMES = new Set([
  "search_skills",
  "load_skill",
  "read_skill_resource",
  "list_repo_memory",
  "record_skill_outcome",
  "forget_repo_memory",
]);
const SAFE_INGESTION_STATES = new Set([
  "queued",
  "running",
  "succeeded",
  "published",
  "quarantined",
  "failed",
  "cancelled",
  "superseded",
  "verified",
  "curated",
]);
const SAFE_REASON_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,35}$/i;

export function securityEvent(
  event: SecurityEventName,
  fields: SecurityEventFields = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    event,
    ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
    ...(fields.accountId === undefined ? {} : { accountId: fields.accountId }),
    ...(fields.apiKeyId === undefined ? {} : { apiKeyId: fields.apiKeyId }),
    ...(fields.code === undefined ? {} : { code: fields.code }),
    ...(fields.tool === undefined || !SAFE_TOOL_NAMES.has(fields.tool)
      ? {}
      : { tool: fields.tool }),
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.sourceId === undefined || !OPAQUE_ID.test(fields.sourceId)
      ? {}
      : { sourceId: fields.sourceId }),
    ...(fields.runId === undefined || !OPAQUE_ID.test(fields.runId)
      ? {}
      : { runId: fields.runId }),
    ...(fields.candidateId === undefined || !OPAQUE_ID.test(fields.candidateId)
      ? {}
      : { candidateId: fields.candidateId }),
    ...(fields.state === undefined || !SAFE_INGESTION_STATES.has(fields.state)
      ? {}
      : { state: fields.state }),
    ...(fields.reasonCode === undefined ||
    !SAFE_REASON_CODE.test(fields.reasonCode)
      ? {}
      : { reasonCode: fields.reasonCode }),
    ...(fields.fencingToken === undefined ||
    !Number.isSafeInteger(fields.fencingToken)
      ? {}
      : { fencingToken: fields.fencingToken }),
    ...(fields.count === undefined ||
    !Number.isSafeInteger(fields.count) ||
    fields.count < 0
      ? {}
      : { count: fields.count }),
  });
}
