import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createOnboardingEnvironment } from "../../helpers/onboarding-environment.js";
import { ensureServiceSecrets } from "../../../src/onboarding/secrets/service-secrets.js";
import {
  createAccountInAdminContainer,
  createClientKeyInAdminContainer,
} from "../../../src/onboarding/adapters/postgres/bootstrap-admin.js";

const exec = promisify(execFile);

async function freePort(): Promise<number> {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Unable to allocate a loopback test port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) done(address.port);
        else reject(error);
      });
    });
  });
}

describe("self-hosted production Compose secret boundary", () => {
  it("mounts independent files without values in environment, config, healthchecks, or logs", () => {
    const text = readFileSync(
      resolve("distribution/self-hosted/compose.yaml"),
      "utf8",
    );
    const compose = parse(text) as {
      services: Record<
        string,
        {
          environment?: Record<string, unknown>;
          secrets?: (string | { source: string })[];
          ports?: string[];
          user?: string;
          cap_add?: string[];
        }
      >;
      secrets: Record<string, { file: string }>;
    };
    expect(Object.keys(compose.secrets).sort()).toEqual([
      "api_key_pepper",
      "postgres_password",
    ]);
    expect(compose.secrets["postgres_password"]?.file).toContain(
      "SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE",
    );
    expect(compose.secrets["api_key_pepper"]?.file).toContain(
      "SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE",
    );
    expect(compose.services["postgres"]?.ports).toBeUndefined();
    expect(compose.services["skillwire"]?.ports).toEqual([
      "127.0.0.1:${SKILLWIRE_PORT:-3000}:3000",
    ]);
    expect(compose.services["skillwire"]?.user).toBe("0:0");
    expect(compose.services["migrate"]?.user).toBe("0:0");
    expect(compose.services["skillwire"]?.cap_add).toEqual([
      "CHOWN",
      "DAC_OVERRIDE",
      "SETGID",
      "SETUID",
    ]);
    expect(compose.services["migrate"]?.cap_add).toEqual([
      "CHOWN",
      "DAC_OVERRIDE",
      "SETGID",
      "SETUID",
    ]);
    expect(compose.services["postgres"]?.cap_add).toEqual([
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
      "SETGID",
      "SETUID",
    ]);
    expect(JSON.stringify(compose.services)).not.toMatch(
      /POSTGRES_PASSWORD(?:"|:)(?!_FILE)/,
    );
    expect(JSON.stringify(compose.services)).not.toMatch(
      /SKILLWIRE_API_KEY_PEPPER(?:"|:)(?!_FILE)/,
    );
  });

  it.skipIf(process.env["SKILLWIRE_RUN_COMPOSE_INTEGRATION"] !== "1")(
    "reaches PostgreSQL/application readiness with real restrictive mounts and zero disclosure",
    async () => {
      const fixture = await createOnboardingEnvironment();
      const installationId = "00000000-0000-4000-8000-000000000001";
      const installationRoot = resolve(
        fixture.stateRoot,
        "installations",
        installationId,
      );
      const image = `skillwire:feature004-${fixture.composeProject}`;
      const composePath = resolve("distribution/self-hosted/compose.yaml");
      const port = await freePort();
      await ensureServiceSecrets(installationRoot, fixture.stateRoot);
      const databasePasswordFile = resolve(
        installationRoot,
        "secrets/database-password",
      );
      const applicationPepperFile = resolve(
        installationRoot,
        "secrets/application-pepper",
      );
      const [databasePassword, applicationPepper] = await Promise.all([
        readFile(databasePasswordFile, "utf8"),
        readFile(applicationPepperFile, "utf8"),
      ]);
      expect(databasePassword).not.toBe(applicationPepper);
      const environment = {
        ...process.env,
        SKILLWIRE_COMPOSE_PROJECT: fixture.composeProject,
        SKILLWIRE_POSTGRES_VOLUME: fixture.postgresVolume,
        SKILLWIRE_IMAGE: image,
        SKILLWIRE_POSTGRES_IMAGE:
          "postgres:17.10-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
        SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE: databasePasswordFile,
        SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE: applicationPepperFile,
        SKILLWIRE_PORT: String(port),
      };
      const composeArgs = [
        "compose",
        "--project-name",
        fixture.composeProject,
        "--file",
        composePath,
      ];
      try {
        await exec("/usr/bin/docker", ["build", "--tag", image, "."], {
          cwd: process.cwd(),
          env: process.env,
          timeout: 240_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        await exec(
          "/usr/bin/docker",
          [...composeArgs, "up", "--detach", "--wait", "--wait-timeout", "120"],
          { cwd: process.cwd(), env: environment, timeout: 180_000 },
        );
        const response = await fetch(
          `http://127.0.0.1:${String(port)}/health/ready`,
        );
        expect(response.ok).toBe(true);
        const processStatus = await exec(
          "/usr/bin/docker",
          [
            ...composeArgs,
            "exec",
            "--no-TTY",
            "skillwire",
            "node",
            "-e",
            "process.stdout.write(require('node:fs').readFileSync('/proc/1/status','utf8'))",
          ],
          { cwd: process.cwd(), env: environment, timeout: 30_000 },
        );
        expect(processStatus.stdout).toMatch(
          /^Uid:\s+10001\s+10001\s+10001\s+10001$/m,
        );
        expect(processStatus.stdout).toMatch(/^CapEff:\s+0+$/m);
        const accountId = await createAccountInAdminContainer({
          dockerExecutable: "/usr/bin/docker",
          composePath,
          projectName: fixture.composeProject,
          environment,
        });
        const clientKey = await createClientKeyInAdminContainer({
          client: "codex",
          dockerExecutable: "/usr/bin/docker",
          composePath,
          projectName: fixture.composeProject,
          accountId,
          runtimeRoot: fixture.runtimeRoot,
          environment,
        });
        expect(clientKey.keyId).toMatch(/^[0-9a-f-]{36}$/);
        expect(clientKey.token).toMatch(/^swk\./);
        const config = await exec(
          "/usr/bin/docker",
          [...composeArgs, "config"],
          { cwd: process.cwd(), env: environment, timeout: 30_000 },
        );
        const logs = await exec(
          "/usr/bin/docker",
          [...composeArgs, "logs", "--no-color"],
          { cwd: process.cwd(), env: environment, timeout: 30_000 },
        );
        const captured = `${config.stdout}${config.stderr}${logs.stdout}${logs.stderr}`;
        expect(captured).not.toContain(databasePassword);
        expect(captured).not.toContain(applicationPepper);
        expect(captured).not.toContain(clientKey.token);
      } catch (error) {
        const diagnostics = await exec(
          "/usr/bin/docker",
          [...composeArgs, "logs", "--no-color"],
          { cwd: process.cwd(), env: environment, timeout: 30_000 },
        ).catch((metadataError: unknown) => {
          const value = metadataError as { stdout?: string; stderr?: string };
          return { stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
        });
        const secretMetadata = await exec(
          "/usr/bin/docker",
          [
            ...composeArgs,
            "run",
            "--rm",
            "--no-deps",
            "--entrypoint",
            "/bin/ls",
            "postgres",
            "-ln",
            "/run/secrets/database_password",
          ],
          { cwd: process.cwd(), env: environment, timeout: 30_000 },
        ).catch((metadataError: unknown) => {
          const value = metadataError as { stdout?: string; stderr?: string };
          return { stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
        });
        const captured = `${diagnostics.stdout}${diagnostics.stderr}${secretMetadata.stdout}${secretMetadata.stderr}`;
        expect(captured).not.toContain(databasePassword);
        expect(captured).not.toContain(applicationPepper);
        throw new Error(
          `Disposable Compose readiness failed: ${captured.slice(0, 4_096)}`,
          { cause: error },
        );
      } finally {
        await exec(
          "/usr/bin/docker",
          [
            ...composeArgs,
            "down",
            "--volumes",
            "--remove-orphans",
            "--timeout",
            "5",
          ],
          { cwd: process.cwd(), env: environment, timeout: 60_000 },
        ).catch(() => undefined);
        await exec("/usr/bin/docker", ["image", "rm", image], {
          timeout: 30_000,
        }).catch(() => undefined);
        await fixture.close();
      }
    },
    300_000,
  );
});
