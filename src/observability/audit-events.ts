import type { SkillWireErrorCode } from "../application/errors.js";

export type SecurityEventName =
  | "authentication_failed"
  | "request_rejected"
  | "request_rate_limited"
  | "tool_failed"
  | "service_started"
  | "service_stopped";

export interface SecurityEventFields {
  readonly requestId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly apiKeyId?: string | undefined;
  readonly code?: SkillWireErrorCode | undefined;
  readonly tool?: string | undefined;
  readonly status?: number | undefined;
}

const SAFE_TOOL_NAMES = new Set([
  "search_skills",
  "load_skill",
  "read_skill_resource",
  "list_repo_memory",
  "record_skill_outcome",
  "forget_repo_memory",
]);

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
  });
}
