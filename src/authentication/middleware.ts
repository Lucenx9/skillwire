import type { MiddlewareHandler } from "hono";

import { safeErrorEnvelope, SkillWireError } from "../application/errors.js";
import type { RequestPrincipal } from "../domain/repository-memory/types.js";
import type { SecurityLogger } from "../observability/logger.js";
import type { ApiKeyAuthenticator } from "./api-key-authenticator.js";
import { parseApiKeyToken } from "./api-key-token.js";

export interface SkillWireHonoEnvironment {
  readonly Variables: {
    readonly requestId: string;
    readonly deadline: number;
    readonly abortController: AbortController;
    readonly principal: RequestPrincipal;
    readonly parsedBody: unknown;
  };
}

export interface RateLimitPolicy {
  readonly accountRequestsPerMinute: number;
  readonly apiKeyRequestsPerMinute: number;
  readonly burst: number;
  readonly authenticationRequestsPerMinute?: number;
  readonly authenticationBurst?: number;
}

export class AuthenticationRateLimiter {
  private readonly requestsPerMinute: number;
  private readonly burst: number;
  private bucket: TokenBucket;

  public constructor(
    policy: RateLimitPolicy,
    private readonly now: () => number = Date.now,
  ) {
    this.requestsPerMinute =
      policy.authenticationRequestsPerMinute ?? policy.apiKeyRequestsPerMinute;
    this.burst = policy.authenticationBurst ?? policy.burst;
    if (
      !Number.isInteger(this.requestsPerMinute) ||
      !Number.isInteger(this.burst) ||
      this.requestsPerMinute < 1 ||
      this.burst < 1
    ) {
      throw new Error("Authentication rate-limit policy is invalid");
    }
    this.bucket = { tokens: this.burst, updatedAt: this.now() };
  }

  public consume(): RateLimitDecision {
    const now = this.now();
    const elapsed = Math.max(0, now - this.bucket.updatedAt);
    this.bucket.tokens = Math.min(
      this.burst,
      this.bucket.tokens + (elapsed * this.requestsPerMinute) / 60_000,
    );
    this.bucket.updatedAt = now;
    if (this.bucket.tokens >= 1) {
      this.bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(((1 - this.bucket.tokens) * 60) / this.requestsPerMinute),
      ),
    };
  }
}

interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export class AccountApiKeyRateLimiter {
  private readonly accounts = new Map<string, TokenBucket>();
  private readonly apiKeys = new Map<string, TokenBucket>();

  public constructor(
    private readonly policy: RateLimitPolicy,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !Number.isInteger(policy.accountRequestsPerMinute) ||
      !Number.isInteger(policy.apiKeyRequestsPerMinute) ||
      !Number.isInteger(policy.burst) ||
      policy.accountRequestsPerMinute < 1 ||
      policy.apiKeyRequestsPerMinute < 1 ||
      policy.burst < 1
    ) {
      throw new Error("Rate-limit policy is invalid");
    }
  }

  private refill(
    buckets: Map<string, TokenBucket>,
    identity: string,
    requestsPerMinute: number,
    now: number,
  ): TokenBucket {
    const bucket = buckets.get(identity) ?? {
      tokens: this.policy.burst,
      updatedAt: now,
    };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(
      this.policy.burst,
      bucket.tokens + (elapsed * requestsPerMinute) / 60_000,
    );
    bucket.updatedAt = now;
    buckets.set(identity, bucket);
    return bucket;
  }

  public consume(principal: RequestPrincipal): RateLimitDecision {
    const now = this.now();
    const account = this.refill(
      this.accounts,
      principal.accountId,
      this.policy.accountRequestsPerMinute,
      now,
    );
    const apiKey = this.refill(
      this.apiKeys,
      principal.apiKeyId,
      this.policy.apiKeyRequestsPerMinute,
      now,
    );
    if (account.tokens >= 1 && apiKey.tokens >= 1) {
      account.tokens -= 1;
      apiKey.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const accountWait =
      account.tokens >= 1
        ? 0
        : ((1 - account.tokens) * 60_000) /
          this.policy.accountRequestsPerMinute;
    const apiKeyWait =
      apiKey.tokens >= 1
        ? 0
        : ((1 - apiKey.tokens) * 60_000) / this.policy.apiKeyRequestsPerMinute;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(Math.max(accountWait, apiKeyWait) / 1000),
      ),
    };
  }
}

export function bearerAuthentication(
  authenticator: ApiKeyAuthenticator,
  logger: SecurityLogger,
): MiddlewareHandler<SkillWireHonoEnvironment> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
    const authenticated =
      match === null
        ? undefined
        : await authenticator.authenticate(match[1] ?? "", {
            signal: context.get("abortController").signal,
            deadline: context.get("deadline"),
          });
    if (authenticated === undefined) {
      const requestId = context.get("requestId");
      logger.emit("authentication_failed", {
        requestId,
        code: "UNAUTHENTICATED",
        status: 401,
      });
      context.header("WWW-Authenticate", "Bearer");
      return context.json(
        safeErrorEnvelope(new SkillWireError("UNAUTHENTICATED"), requestId),
        401,
      );
    }
    context.set("principal", {
      ...authenticated,
      requestId: context.get("requestId"),
      signal: context.get("abortController").signal,
      deadline: context.get("deadline"),
    });
    await next();
    return;
  };
}

export function rateLimitAuthentication(
  limiter: AuthenticationRateLimiter,
  logger: SecurityLogger,
): MiddlewareHandler<SkillWireHonoEnvironment> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
    if (match !== null && parseApiKeyToken(match[1] ?? "") !== undefined) {
      const decision = limiter.consume();
      if (!decision.allowed) {
        const requestId = context.get("requestId");
        logger.emit("request_rate_limited", {
          requestId,
          code: "RATE_LIMITED",
          status: 429,
        });
        context.header("Retry-After", String(decision.retryAfterSeconds));
        return context.json(
          safeErrorEnvelope(new SkillWireError("RATE_LIMITED"), requestId),
          429,
        );
      }
    }
    await next();
    return;
  };
}

export function rateLimitRequests(
  limiter: AccountApiKeyRateLimiter,
  logger: SecurityLogger,
): MiddlewareHandler<SkillWireHonoEnvironment> {
  return async (context, next) => {
    const principal = context.get("principal");
    const decision = limiter.consume(principal);
    if (!decision.allowed) {
      logger.emit("request_rate_limited", {
        requestId: principal.requestId,
        accountId: principal.accountId,
        apiKeyId: principal.apiKeyId,
        code: "RATE_LIMITED",
        status: 429,
      });
      context.header("Retry-After", String(decision.retryAfterSeconds));
      return context.json(
        safeErrorEnvelope(
          new SkillWireError("RATE_LIMITED"),
          principal.requestId,
        ),
        429,
      );
    }
    await next();
    return;
  };
}
