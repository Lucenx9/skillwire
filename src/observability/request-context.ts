import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import type { SkillWireHonoEnvironment } from "../authentication/middleware.js";

export function requestContext(
  deadlineMilliseconds: number,
  now: () => number = Date.now,
): MiddlewareHandler<SkillWireHonoEnvironment> {
  return async (context, next) => {
    context.set("requestId", randomUUID());
    context.set("deadline", now() + deadlineMilliseconds);
    context.set("abortController", new AbortController());
    await next();
  };
}
