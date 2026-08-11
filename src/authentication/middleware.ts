import { timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

function tokensMatch(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

export function bearerAuthentication(expectedToken: string): MiddlewareHandler {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
    if (match === null || !tokensMatch(match[1] ?? "", expectedToken)) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json({ error: "UNAUTHENTICATED" }, 401);
    }
    await next();
    return;
  };
}
