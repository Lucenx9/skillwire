import { serve } from "@hono/node-server";

import { createApplication } from "./composition.js";
import { loadConfig } from "./config.js";
import { createSecurityLogger } from "./observability/logger.js";

const config = loadConfig();
const logger = createSecurityLogger();
const application = await createApplication(config);
const server = serve(
  { fetch: application.app.fetch, hostname: config.host, port: config.port },
  (info) => {
    logger.emit("service_started", { status: info.port });
  },
);

const shutdown = (): void => {
  server.close((error) => {
    application
      .close()
      .catch(() => {
        logger.emit("service_stopped", { status: 1 });
        process.exitCode = 1;
      })
      .finally(() => {
        if (error) {
          logger.emit("service_stopped", { status: 1 });
          process.exitCode = 1;
        } else {
          logger.emit("service_stopped", { status: 0 });
        }
      });
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
