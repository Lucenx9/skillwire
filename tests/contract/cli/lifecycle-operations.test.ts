/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production lifecycle interfaces. */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  routeAdministrativeCommand,
  type AdministrativeOperations,
} from "../../../src/onboarding/cli/command-router.js";
import { createProductionLifecycleOperations } from "../../../src/onboarding/application/production-lifecycle.js";
import { ensureServiceSecrets } from "../../../src/onboarding/secrets/service-secrets.js";
import { createOwnershipLedger } from "../../../src/onboarding/domain/ownership.js";
import { JournaledOperationFailure } from "../../../src/onboarding/domain/operation-journal.js";
import type { ParsedCommand } from "../../../src/onboarding/cli/main.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

describe("administrative lifecycle routes", () => {
  let fixture: OnboardingEnvironment | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  it("renders bounded installed status as JSON on stdout without mutation", async () => {
    fixture = await createOnboardingEnvironment();
    const stateRoot = resolve(fixture.root, "admin-state");
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const installationId = randomUUID();
    await writeFile(
      resolve(stateRoot, "installation.json"),
      `${JSON.stringify({
        schemaVersion: "skillwire.installation/v1",
        installationId,
        ownerUid: process.getuid?.() ?? 0,
        accountId: randomUUID(),
        activeReleaseId: "7-amd64",
        highestAcceptedReleaseSequence: 7,
        activeTrustPolicySequence: 3,
        endpoint: `unix://${resolve(fixture.runtimeRoot, "skillwire/mcp.sock")}`,
        composeProject: "skillwire-test",
        postgresVolume: "skillwire-test_postgres_data",
        selectedClients: ["codex"],
        clientIntegrationIds: { codex: randomUUID(), claude: null },
        status: "complete",
        createdAt: "2026-08-14T08:00:00.000Z",
        updatedAt: "2026-08-14T08:00:00.000Z",
        lastValidatedAt: "2026-08-14T08:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const before = await fixtureSnapshot(stateRoot);
    vi.stubEnv("SKILLWIRE_ALLOW_STATE_ROOT", "test");
    let stdout = "";
    let stderr = "";
    const command: ParsedCommand = {
      route: "status",
      output: "json",
      previewOnly: false,
      stateRoot,
    };

    const code = await routeAdministrativeCommand(
      command,
      {
        stdout: (value) => (stdout += value),
        stderr: (value) => (stderr += value),
      },
      new AbortController().signal,
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      command: "status",
      status: "success",
      changed: false,
      components: [
        {
          component: "installation",
          state: "complete",
          owned: true,
          identity: { installationId },
        },
      ],
    });
    expect(stderr).toBe("");
    expect(await fixtureSnapshot(stateRoot)).toEqual(before);
  });

  it("uses the production live-status operation when one is supplied", async () => {
    const operation = vi.fn(async () => ({
      schemaVersion: "skillwire.admin-result/v1" as const,
      command: "status" as const,
      operationId: randomUUID(),
      status: "success" as const,
      exitClass: "success" as const,
      previewHash: null,
      changed: false,
      summary: "bounded live state",
      components: [
        {
          component: "postgres",
          state: "ready",
          changed: false,
          owned: true,
          identity: { migration: "010" },
        },
      ],
      findings: [],
      recovery: {
        rollbackBoundary: "none" as const,
        backupId: null,
        instructions: [],
      },
    }));
    let stdout = "";
    const code = await routeAdministrativeCommand(
      {
        route: "status",
        output: "json",
        previewOnly: false,
      },
      { stdout: (value) => (stdout += value), stderr: vi.fn() },
      new AbortController().signal,
      { status: operation },
    );
    expect(code).toBe(0);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout)).toMatchObject({
      components: [{ component: "postgres", state: "ready" }],
    });
  });

  it("rejects a missing absolute XDG runtime root before deriving any path from cwd", async () => {
    fixture = await createOnboardingEnvironment();
    const operations = createProductionLifecycleOperations({
      ...fixture.environment,
      XDG_RUNTIME_DIR: undefined,
    });

    await expect(
      operations.status?.(
        {
          route: "status",
          output: "json",
          previewOnly: false,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "Absolute HOME and XDG data/state/runtime roots are required for lifecycle operations",
    );
  });

  it("does not report a complete installation healthy when its owned Docker service is unavailable", async () => {
    fixture = await createOnboardingEnvironment();
    const stateRoot = resolve(fixture.xdgStateHome, "skillwire");
    const dataRoot = resolve(fixture.xdgDataHome, "skillwire");
    const installationId = randomUUID();
    const installationRoot = resolve(dataRoot, "installations", installationId);
    const secretReferences = await ensureServiceSecrets(
      installationRoot,
      dataRoot,
    );
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const writeProtected = (name: string, value: unknown) =>
      writeFile(resolve(stateRoot, name), `${JSON.stringify(value)}\n`, {
        mode: 0o600,
      });
    const timestamp = "2026-08-14T08:00:00.000Z";
    await Promise.all([
      writeProtected("installation.json", {
        schemaVersion: "skillwire.installation/v1",
        installationId,
        ownerUid: process.getuid?.() ?? 0,
        accountId: randomUUID(),
        activeReleaseId: "7-amd64",
        highestAcceptedReleaseSequence: 7,
        activeTrustPolicySequence: 3,
        endpoint: `unix://${resolve(fixture.runtimeRoot, "skillwire/mcp.sock")}`,
        composeProject: fixture.composeProject,
        postgresVolume: fixture.postgresVolume,
        selectedClients: [],
        clientIntegrationIds: { codex: null, claude: null },
        status: "complete",
        createdAt: timestamp,
        updatedAt: timestamp,
        lastValidatedAt: timestamp,
      }),
      writeProtected(
        "ownership.json",
        createOwnershipLedger(installationId).record,
      ),
      writeProtected("service-secret-set.json", {
        schemaVersion: "skillwire.service-secret-set/v1",
        serviceSecretSetId: randomUUID(),
        installationId,
        createdByOperation: randomUUID(),
        secrets: secretReferences,
        state: "available",
      }),
      writeProtected("deployment.json", {
        schemaVersion: "skillwire.deployment/v1",
        installationId,
        releaseRoot: resolve(dataRoot, "releases/skillwire-7-amd64"),
        composePath: resolve(
          dataRoot,
          "releases/skillwire-7-amd64/compose.yaml",
        ),
        skillwireImage: `docker.io/skillwire/app@sha256:${"a".repeat(64)}`,
        postgresImage: `docker.io/library/postgres@sha256:${"b".repeat(64)}`,
        databasePasswordFile: resolve(
          installationRoot,
          "secrets/database-password",
        ),
        applicationPepperFile: resolve(
          installationRoot,
          "secrets/application-pepper",
        ),
        runtimeSocketDirectory: resolve(fixture.runtimeRoot, "skillwire"),
        socketPath: resolve(fixture.runtimeRoot, "skillwire/mcp.sock"),
        projectName: fixture.composeProject,
        volumeName: fixture.postgresVolume,
      }),
    ]);

    const doctor = createProductionLifecycleOperations(
      fixture.environment,
    ).doctor;
    const report = await doctor?.(
      { route: "doctor", output: "json", previewOnly: false, stateRoot },
      new AbortController().signal,
    );
    expect(report).toMatchObject({ status: "incomplete", changed: false });
    expect(report?.findings.map(({ code }) => code)).toContain(
      "SERVICE_STOPPED",
    );
  });

  it.each([
    ["doctor", {}],
    ["repair", { component: "codex" }],
    ["clients:rotate-key", { client: "codex" }],
    [
      "maintenance:rotate-service-secret",
      { serviceSecret: "application-pepper" },
    ],
    ["backup", {}],
    ["upgrade", { release: "/tmp/verified-release.tar.zst" }],
    ["clients:uninstall", { client: "claude" }],
    ["uninstall", {}],
    ["purge", {}],
  ] as const)(
    "routes %s with stable JSON/exit/stdout separation",
    async (route, extra) => {
      const command = {
        route,
        output: "json" as const,
        previewOnly: route !== "doctor",
        ...extra,
      } satisfies ParsedCommand;
      const previewHash = command.previewOnly ? "f".repeat(64) : null;
      const operations: AdministrativeOperations = {
        [route]: async () => ({
          schemaVersion: "skillwire.admin-result/v1" as const,
          command: route,
          operationId: randomUUID(),
          status: command.previewOnly ? "preview" : "success",
          exitClass: "success" as const,
          previewHash,
          changed: false,
          summary: `${route} completed safely`,
          components: [],
          findings: [],
          recovery: {
            rollbackBoundary: "none" as const,
            backupId: null,
            instructions: [],
          },
        }),
      };
      let stdout = "";
      let stderr = "";
      const code = await routeAdministrativeCommand(
        command,
        {
          stdout: (value) => (stdout += value),
          stderr: (value) => (stderr += value),
        },
        new AbortController().signal,
        operations,
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        command: route,
        exitClass: "success",
        changed: false,
      });
      expect(stderr).toBe("");
    },
  );

  it.each([
    ["repair", { component: "service" }],
    ["clients:rotate-key", { client: "codex" }],
    [
      "maintenance:rotate-service-secret",
      { serviceSecret: "database-password" },
    ],
    ["backup", {}],
    ["upgrade", { release: "/tmp/verified-release.tar.zst" }],
    ["clients:uninstall", { client: "claude" }],
    ["uninstall", {}],
    ["purge", {}],
  ] as const)(
    "rejects a remote named Docker context before executing %s",
    async (route, extra) => {
      fixture = await createOnboardingEnvironment();
      const resolveDockerEnvironment = vi.fn(async () => {
        throw new Error(
          "A local Docker context is required; remote contexts are refused",
        );
      });
      const operations = createProductionLifecycleOperations(
        fixture.environment,
        { resolveDockerEnvironment },
      );
      const operation = operations[route];
      expect(operation).toBeDefined();

      await expect(
        operation?.(
          {
            route,
            output: "json",
            previewOnly: false,
            ...extra,
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/local Docker context|remote context/i);
      expect(resolveDockerEnvironment).toHaveBeenCalledOnce();
    },
  );

  it("reports a journaled partial lifecycle mutation as recovery-required", async () => {
    let stdout = "";
    const code = await routeAdministrativeCommand(
      {
        route: "uninstall",
        output: "json",
        previewOnly: false,
        confirmPreview: "a".repeat(64),
      },
      {
        stdout: (value) => (stdout += value),
        stderr: vi.fn(),
      },
      new AbortController().signal,
      {
        uninstall: async () => {
          throw new JournaledOperationFailure(
            "owned uninstall effect may have completed",
            "application-config",
            { cause: new Error("simulated post-effect failure") },
          );
        },
      },
    );

    expect(code).toBe(10);
    expect(JSON.parse(stdout)).toMatchObject({
      command: "uninstall",
      status: "recovery-required",
      exitClass: "rollback-required",
      changed: true,
      findings: [
        {
          code: "LIFECYCLE_RECOVERY_REQUIRED",
          severity: "recovery-required",
        },
      ],
      recovery: { rollbackBoundary: "application-config" },
    });
  });
});

async function fixtureSnapshot(root: string): Promise<string> {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const names = (await readdir(root)).sort();
  const entries = await Promise.all(
    names.map(async (name) => {
      const path = resolve(root, name);
      const metadata = await stat(path);
      return `${name}:${String(metadata.mode & 0o777)}:${await readFile(path, "utf8")}`;
    }),
  );
  return entries.join("\n");
}
