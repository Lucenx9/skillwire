import { serve } from "@hono/node-server";

import { createApplication } from "./composition.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const application = await createApplication(config);
const server = serve(
  { fetch: application.app.fetch, hostname: config.host, port: config.port },
  (info) => {
    process.stdout.write(
      `SkillWire listening on http://${config.host}:${String(info.port)}\n`,
    );
  },
);

const shutdown = (): void => {
  server.close((error) => {
    application
      .close()
      .catch((closeError: unknown) => {
        process.stderr.write(
          `${closeError instanceof Error ? closeError.message : "Shutdown failed"}\n`,
        );
        process.exitCode = 1;
      })
      .finally(() => {
        if (error) {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 1;
        }
      });
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
