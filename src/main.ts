import type { Server } from "node:http";
import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createAdaptorServer, serve } from "@hono/node-server";

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

interface SocketIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

async function validateSocketDirectory(socketPath: string): Promise<void> {
  const parentPath = dirname(socketPath);
  const parts = relative("/", parentPath).split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    current = resolve(current, part);
    const ancestor = await lstat(current);
    if (ancestor.isSymbolicLink() || !ancestor.isDirectory())
      throw new Error("Unix socket directory ancestry is unsafe");
  }
  const parent = await lstat(parentPath);
  if (parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) {
    throw new Error("Unix socket directory is unsafe");
  }
}

async function unlinkSocketIfIdentity(
  socketPath: string,
  identity: SocketIdentity,
): Promise<void> {
  try {
    const socket = await lstat(socketPath, { bigint: true });
    if (socket.dev === identity.device && socket.ino === identity.inode)
      await unlink(socketPath);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
}

export async function startHttpService(
  config: ApplicationConfig,
  logger: SecurityLogger = createSecurityLogger(
    undefined,
    config.logLevel ?? "info",
  ),
): Promise<RunningService> {
  const application = await createApplication(
    config,
    config.catalogRoot ?? process.cwd(),
  );
  let server: Server;
  let serverToCleanup: Server | undefined;
  let socketIdentity: SocketIdentity | undefined;
  try {
    if (config.unixSocketPath === undefined) {
      server = serve({
        fetch: application.app.fetch,
        hostname: config.host,
        port: config.port,
      }) as Server;
      serverToCleanup = server;
    } else {
      await validateSocketDirectory(config.unixSocketPath);
      try {
        const stale = await lstat(config.unixSocketPath);
        if (
          !stale.isSocket() ||
          stale.isSymbolicLink() ||
          stale.nlink !== 1 ||
          stale.uid !== (process.getuid?.() ?? -1) ||
          (stale.mode & 0o777) !== 0o600
        ) {
          throw new Error("Existing Unix socket path is unsafe");
        }
        await unlink(config.unixSocketPath);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
      }
      server = createAdaptorServer({
        fetch: application.app.fetch,
        hostname: "localhost",
      }) as Server;
      serverToCleanup = server;
      server.listen(config.unixSocketPath);
    }
    await new Promise<void>((resolveListening, reject) => {
      server.once("listening", resolveListening);
      server.once("error", reject);
    });
    if (config.unixSocketPath !== undefined) {
      await chmod(config.unixSocketPath, 0o600);
      const socket = await lstat(config.unixSocketPath, { bigint: true });
      socketIdentity = { device: socket.dev, inode: socket.ino };
      if (
        !socket.isSocket() ||
        socket.nlink !== 1n ||
        socket.uid !== BigInt(process.getuid?.() ?? -1) ||
        (socket.mode & 0o777n) !== 0o600n
      ) {
        throw new Error("Created Unix socket is unsafe");
      }
    }
  } catch (error) {
    if (serverToCleanup !== undefined) {
      const cleanupServer = serverToCleanup;
      await new Promise<void>((done) => {
        try {
          cleanupServer.close(() => {
            done();
          });
        } catch {
          done();
        }
      });
    }
    if (config.unixSocketPath !== undefined && socketIdentity !== undefined)
      await unlinkSocketIfIdentity(config.unixSocketPath, socketIdentity);
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
            .then(async () => {
              if (
                config.unixSocketPath !== undefined &&
                socketIdentity !== undefined
              ) {
                await unlinkSocketIfIdentity(
                  config.unixSocketPath,
                  socketIdentity,
                );
              }
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
