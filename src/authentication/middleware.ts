import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import type { RequestPrincipal } from "../domain/repository-memory/types.js";
import type { ApiKeyAuthenticator } from "./api-key-authenticator.js";

export interface SkillWireHonoEnvironment {
  readonly Variables: {
    readonly principal: RequestPrincipal;
  };
}

export function bearerAuthentication(
  authenticator: ApiKeyAuthenticator,
): MiddlewareHandler<SkillWireHonoEnvironment> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
    const authenticated =
      match === null
        ? undefined
        : await authenticator.authenticate(match[1] ?? "");
    if (authenticated === undefined) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json({ error: "UNAUTHENTICATED" }, 401);
    }
    context.set("principal", {
      ...authenticated,
      requestId: randomUUID(),
    });
    await next();
    return;
  };
}
