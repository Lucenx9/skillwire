export type SkillWireErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "REVISION_UNAVAILABLE"
  | "RESOURCE_REJECTED"
  | "MEMORY_CONFLICT"
  | "ERASURE_INCOMPLETE"
  | "RATE_LIMITED"
  | "INTERNAL";

const SAFE_MESSAGES: Readonly<Record<SkillWireErrorCode, string>> = {
  UNAUTHENTICATED: "Authentication is required.",
  INVALID_ARGUMENT: "The request is invalid.",
  NOT_FOUND: "The requested item was not found.",
  REVISION_UNAVAILABLE: "The exact revision is temporarily unavailable.",
  RESOURCE_REJECTED: "The requested resource was rejected.",
  MEMORY_CONFLICT: "The requested memory update cannot be applied.",
  ERASURE_INCOMPLETE: "Repository memory could not be erased.",
  RATE_LIMITED: "The request rate limit was exceeded.",
  INTERNAL: "The request could not be completed.",
};

const RETRYABLE = new Set<SkillWireErrorCode>([
  "REVISION_UNAVAILABLE",
  "ERASURE_INCOMPLETE",
  "RATE_LIMITED",
  "INTERNAL",
]);

export class SkillWireError extends Error {
  public readonly retryable: boolean;

  public constructor(readonly code: SkillWireErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "SkillWireError";
    this.retryable = RETRYABLE.has(code);
  }
}

export function safeSkillWireError(error: unknown): SkillWireError {
  return error instanceof SkillWireError
    ? error
    : new SkillWireError("INTERNAL");
}

export interface SafeErrorEnvelope {
  readonly error: {
    readonly code: SkillWireErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly requestId: string;
  };
}

export function safeErrorEnvelope(
  error: unknown,
  requestId: string,
): SafeErrorEnvelope {
  const safe = safeSkillWireError(error);
  return {
    error: {
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
      requestId,
    },
  };
}
