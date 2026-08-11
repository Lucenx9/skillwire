import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import type { SkillWireHonoEnvironment } from "../authentication/middleware.js";

export function requestContext(
  deadlineMilliseconds: number,
): MiddlewareHandler<SkillWireHonoEnvironment> {
  return async (context, next) => {
    context.set("requestId", randomUUID());
    context.set("deadline", Date.now() + deadlineMilliseconds);
    await next();
  };
}
