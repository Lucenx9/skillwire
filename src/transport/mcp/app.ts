import {
  createMcpHandler,
  isJsonContentType,
  validateHostHeader,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { ApiKeyAuthenticator } from "../../authentication/api-key-authenticator.js";
import {
  AccountApiKeyRateLimiter,
  bearerAuthentication,
  rateLimitRequests,
  type RateLimitPolicy,
  type SkillWireHonoEnvironment,
} from "../../authentication/middleware.js";
import { safeErrorEnvelope, SkillWireError } from "../../application/errors.js";
import { runWithRequestExecution } from "../../application/request-execution.js";
import type { ReadinessState } from "../../lifecycle/readiness-state.js";
import type { SecurityLogger } from "../../observability/logger.js";
import { requestContext } from "../../observability/request-context.js";
import { createMcpServer, type McpUseCases } from "./server-factory.js";

export interface CreateAppOptions {
  readonly allowedHosts: readonly string[];
  readonly authenticator: ApiKeyAuthenticator;
  readonly readiness: ReadinessState;
  readonly checkReadiness?: (() => Promise<boolean>) | undefined;
  readonly useCases: McpUseCases;
  readonly logger: SecurityLogger;
  readonly maximumRequestBodyBytes: number;
  readonly requestDeadlineMilliseconds: number;
  readonly rateLimit: RateLimitPolicy;
  readonly now?: (() => number) | undefined;
}

export function createApp(options: CreateAppOptions) {
  const app = new Hono<SkillWireHonoEnvironment>();
  const now = options.now ?? Date.now;
  const limiter = new AccountApiKeyRateLimiter(options.rateLimit, now);
  const isReady =
    options.checkReadiness ??
    (() => Promise.resolve(options.readiness.isReady()));

  app.use("*", requestContext(options.requestDeadlineMilliseconds, now));
  app.use("*", async (context, next) => {
    if (now() >= context.get("deadline")) {
      context.get("abortController").abort();
      const requestId = context.get("requestId");
      options.logger.emit("request_rejected", {
        requestId,
        code: "INTERNAL",
        status: 503,
      });
      return context.json(
        safeErrorEnvelope(new SkillWireError("INTERNAL"), requestId),
        503,
      );
    }
    const completion = runWithRequestExecution(
      {
        signal: context.get("abortController").signal,
        deadline: context.get("deadline"),
      },
      () =>
        next().then(
          () => "completed" as const,
          (error: unknown) => ({ error }) as const,
        ),
    );
    const timeout = new Promise<"timed-out">((resolve) => {
      const timer = setTimeout(() => {
        context.get("abortController").abort();
        resolve("timed-out");
      }, options.requestDeadlineMilliseconds);
      timer.unref();
    });
    const result = await Promise.race([completion, timeout]);
    if (
      result === "timed-out" ||
      context.get("abortController").signal.aborted ||
      now() >= context.get("deadline")
    ) {
      context.get("abortController").abort();
      const requestId = context.get("requestId");
      options.logger.emit("request_rejected", {
        requestId,
        code: "INTERNAL",
        status: 503,
      });
      return context.json(
        safeErrorEnvelope(new SkillWireError("INTERNAL"), requestId),
        503,
      );
    }
    if (typeof result === "object") throw result.error;
    return;
  });
  app.use("*", async (context, next) => {
    const result = validateHostHeader(context.req.header("host"), [
      ...options.allowedHosts,
    ]);
    if (!result.ok) {
      const requestId = context.get("requestId");
      options.logger.emit("request_rejected", {
        requestId,
        code: "INVALID_ARGUMENT",
        status: 403,
      });
      return context.json(
        safeErrorEnvelope(new SkillWireError("INVALID_ARGUMENT"), requestId),
        403,
      );
    }
    await next();
    return;
  });

  app.get("/health/live", (context) => context.json({ status: "ok" }));
  app.get("/health/ready", async (context) =>
    (await isReady())
      ? context.json({ status: "ready" })
      : context.json({ status: "not-ready" }, 503),
  );

  app.use("/mcp", async (context, next) => {
    if (!(await isReady())) {
      return context.json(
        safeErrorEnvelope(
          new SkillWireError("INTERNAL"),
          context.get("requestId"),
        ),
        503,
      );
    }
    await next();
    return;
  });
  app.use("/mcp", async (context, next) => {
    if (
      context.req.method === "POST" &&
      !isJsonContentType(context.req.header("content-type"))
    ) {
      const requestId = context.get("requestId");
      options.logger.emit("request_rejected", {
        requestId,
        code: "INVALID_ARGUMENT",
        status: 400,
      });
      return context.json(
        safeErrorEnvelope(new SkillWireError("INVALID_ARGUMENT"), requestId),
        400,
      );
    }
    await next();
    return;
  });
  app.use(
    "/mcp",
    bodyLimit({
      maxSize: options.maximumRequestBodyBytes,
      onError: (context) => {
        const requestId = context.get("requestId") as string;
        options.logger.emit("request_rejected", {
          requestId,
          code: "INVALID_ARGUMENT",
          status: 413,
        });
        return context.json(
          safeErrorEnvelope(new SkillWireError("INVALID_ARGUMENT"), requestId),
          413,
        );
      },
    }),
  );
  app.use("/mcp", async (context, next) => {
    if (context.req.method === "POST") {
      try {
        context.set("parsedBody", await context.req.raw.clone().json());
      } catch {
        return context.json(
          safeErrorEnvelope(
            new SkillWireError("INVALID_ARGUMENT"),
            context.get("requestId"),
          ),
          400,
        );
      }
    }
    await next();
    return;
  });
  app.use("/mcp", bearerAuthentication(options.authenticator, options.logger));
  app.use("/mcp", rateLimitRequests(limiter, options.logger));

  app.post("/mcp", (context) => {
    const principal = context.get("principal");
    const handler = createMcpHandler(
      () => createMcpServer(options.useCases, principal, options.logger),
      { legacy: "stateless" },
    );
    return handler.fetch(context.req.raw, {
      parsedBody: context.get("parsedBody"),
    });
  });
  app.all("/mcp", (context) => context.text("Method not allowed.", 405));

  app.onError((_, context) => {
    const requestId = context.get("requestId");
    options.logger.emit("request_rejected", {
      requestId,
      code: "INTERNAL",
      status: 500,
    });
    return context.json(
      safeErrorEnvelope(new SkillWireError("INTERNAL"), requestId),
      500,
    );
  });

  return app;
}
