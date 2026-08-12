import type { Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { serve } from "@hono/node-server";

import { createApplication, type Application } from "./composition.js";
import { loadConfig, type ApplicationConfig } from "./config.js";
import {
  createSecurityLogger,
  type SecurityLogger,
} from "./observability/logger.js";

export interface RunningService {
  readonly server: Server;
  readonly application: Application;
  close(): Promise<void>;
}

export async function startHttpService(
  config: ApplicationConfig,
  logger: SecurityLogger = createSecurityLogger(
    undefined,
    config.logLevel ?? "info",
  ),
): Promise<RunningService> {
  const application = await createApplication(config);
  let server: Server;
  try {
    server = serve({
      fetch: application.app.fetch,
      hostname: config.host,
      port: config.port,
    }) as Server;
    await new Promise<void>((resolveListening, reject) => {
      server.once("listening", resolveListening);
      server.once("error", reject);
    });
  } catch (error) {
    await application.close();
    throw error;
  }

  const address = server.address();
  logger.emit("service_started", {
    status: typeof address === "object" && address !== null ? address.port : 0,
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    application,
    close() {
      closing ??= new Promise<void>((resolveClose, rejectClose) => {
        const forceTimer = setTimeout(() => {
          server.closeAllConnections();
        }, config.shutdownGraceMilliseconds ?? 10_000);
        forceTimer.unref();
        server.close((error) => {
          clearTimeout(forceTimer);
          application
            .close()
            .then(() => {
              if (error) rejectClose(error);
              else resolveClose();
            })
            .catch(rejectClose);
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}

async function runFromCommandLine(): Promise<void> {
  let logger: SecurityLogger = createSecurityLogger();
  try {
    const config = loadConfig();
    logger = createSecurityLogger(undefined, config.logLevel ?? "info");
    const service = await startHttpService(config, logger);
    const shutdown = (): void => {
      service
        .close()
        .then(() => {
          logger.emit("service_stopped", { status: 0 });
        })
        .catch(() => {
          logger.emit("service_stopped", { status: 1 });
          process.exitCode = 1;
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    logger.emit("service_stopped", { status: 1 });
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  void runFromCommandLine();
}
