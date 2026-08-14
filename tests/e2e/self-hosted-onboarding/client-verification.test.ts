import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { resolve } from "node:path";

import { createAdaptorServer } from "@hono/node-server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import { createTestApplication } from "../../../src/composition.js";
import {
  combineClientVerificationEvidence,
  verifyClientIntegration,
} from "../../../src/onboarding/application/client-verification.js";
import { runActivationDiagnostic } from "../../../src/onboarding/application/activation-diagnostic.js";
import { RestrictiveFileCredentialStore } from "../../../src/onboarding/adapters/credentials/restrictive-file.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { FakeRepositoryMemoryStore } from "../../helpers/memory-store.js";

describe("fresh-process deterministic client verification", () => {
  let fixture: OnboardingEnvironment | undefined;
  let server: Server | undefined;

  beforeAll(() => {
    if (process.env["SKILLWIRE_PREBUILT_TEST_IMAGE"] !== "true") {
      execFileSync("pnpm", ["build"], { cwd: process.cwd(), stdio: "pipe" });
    }
  }, 30_000);

  afterEach(async () => {
    if (server !== undefined) {
      const activeServer = server;
      await new Promise<void>((done, reject) =>
        activeServer.close((error) => {
          if (error === undefined) done();
          else reject(error);
        }),
      );
      server = undefined;
    }
    await fixture?.close();
    fixture = undefined;
  });

  it.each(["codex", "claude"] as const)(
    "starts ordinary %s and runs exact bridge registration, six tools, search/load/resource, provenance, advisory, and post-inventory",
    async (client) => {
      fixture = await createOnboardingEnvironment();
      const token = createApiKeyToken().token;
      const { app } = createTestApplication({
        memoryStore: new FakeRepositoryMemoryStore(),
        authenticator: {
          authenticate: (candidate) =>
            Promise.resolve(
              candidate === token
                ? {
                    accountId: "00000000-0000-4000-8000-000000000001",
                    apiKeyId: "00000000-0000-4000-8000-000000000002",
                  }
                : undefined,
            ),
        },
      });
      const socketDirectory = resolve(fixture.runtimeRoot, "service");
      const socketPath = resolve(socketDirectory, "mcp.sock");
      await mkdir(socketDirectory, { mode: 0o700 });
      server = createAdaptorServer({
        fetch: app.fetch,
        hostname: "localhost",
      }) as Server;
      server.listen(socketPath);
      await new Promise<void>((done) => server?.once("listening", done));
      await chmod(socketPath, 0o600);
      const installationId = "00000000-0000-4000-8000-000000000001";
      const installationRoot = resolve(
        fixture.xdgStateHome,
        "skillwire/installations",
        installationId,
      );
      await mkdir(installationRoot, { recursive: true, mode: 0o700 });
      const store = new RestrictiveFileCredentialStore(
        fixture.stateRoot,
        fixture.stateRoot,
        installationId,
      );
      const credentialReference = await store.store(client, token, true);
      await writeFile(
        resolve(installationRoot, "bridge-state.json"),
        `${JSON.stringify({
          schemaVersion: "skillwire.bridge-state/v1",
          installationId,
          transport: "unix-domain-socket",
          endpoint: "http://localhost/mcp",
          socketPath,
          clients: [{ client, credentialReference }],
        })}\n`,
        { mode: 0o600 },
      );
      const launcher = resolve("dist/src/onboarding/cli/main.js");
      if (process.env["SKILLWIRE_PREBUILT_TEST_IMAGE"] === "true") {
        await access(launcher, constants.X_OK);
      } else {
        await chmod(launcher, 0o755);
      }
      const registration = {
        command: launcher,
        args: ["bridge", "--installation", installationId, "--client", client],
      };
      let inventoryCalls = 0;
      const result = await verifyClientIntegration({
        client,
        vendorExecutable: resolve(`node_modules/.bin/${client}`),
        installationId,
        registration,
        expectedLauncher: launcher,
        environment: fixture.environment,
        inventory: () => {
          inventoryCalls += 1;
          return Promise.resolve(registration);
        },
      });
      expect(result.tools).toHaveLength(6);
      expect(result.evidenceKind).toBe("deterministic");
      expect(result.skillId).toBe("typescript-code-review");
      expect(result.revisionSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.provenanceTrust).toBe("trusted");
      expect(result.advisoryStatus).toBe("available");
      expect(result.resourceVerified).toBe(true);
      expect(inventoryCalls).toBe(2);
    },
    20_000,
  );

  it.each([
    ["missing", "missing-codex"],
    ["broken", "broken-codex"],
    ["incompatible", "incompatible-codex"],
  ])(
    "does not accept direct bridge evidence when the ordinary client is %s",
    async (kind, fileName) => {
      fixture = await createOnboardingEnvironment();
      const executablePath = resolve(fixture.root, fileName);
      if (kind === "broken") {
        await writeFile(executablePath, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
      } else if (kind === "incompatible") {
        await writeFile(
          executablePath,
          "#!/bin/sh\nprintf 'codex-cli 0.146.0\\n'\n",
          {
            mode: 0o700,
          },
        );
      }
      const installationId = "00000000-0000-4000-8000-000000000001";
      const launcher = resolve("dist/src/onboarding/cli/main.js");
      const registration = {
        command: launcher,
        args: ["bridge", "--installation", installationId, "--client", "codex"],
      };

      await expect(
        verifyClientIntegration({
          client: "codex",
          vendorExecutable: executablePath,
          installationId,
          registration,
          expectedLauncher: launcher,
          environment: fixture.environment,
          inventory: () => Promise.resolve(registration),
        }),
      ).rejects.toThrow();
    },
  );

  it("keeps model-dependent automatic evidence separate and non-gating", async () => {
    const notInvoked = await runActivationDiagnostic("codex", () =>
      Promise.resolve("not-invoked"),
    );
    expect(notInvoked).toMatchObject({
      client: "codex",
      status: "not-invoked",
      attempts: 1,
      changedInstallationState: false,
    });
    const failed = await runActivationDiagnostic("claude", () =>
      Promise.reject(new Error("ordinary session unavailable")),
    );
    expect(failed).toMatchObject({
      status: "failed",
      attempts: 1,
      changedInstallationState: false,
    });
    expect(JSON.stringify([notInvoked, failed])).not.toMatch(
      /swk\.|prompt|response|account/i,
    );
    const deterministic = {
      evidenceKind: "deterministic" as const,
      client: "codex" as const,
      tools: [],
      skillId: "fixture",
      revision: "1.0.0",
      revisionSha256: "a".repeat(64),
      advisoryStatus: "available",
      provenanceTrust: "trusted",
      resourceVerified: true,
    };
    expect(
      combineClientVerificationEvidence(deterministic, notInvoked),
    ).toMatchObject({
      integrationState: "verified",
      deterministic: { evidenceKind: "deterministic" },
      automatic: { status: "not-invoked" },
    });
  });
});
