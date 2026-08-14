import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeploymentOptions } from "../../../src/onboarding/adapters/docker/deployment.js";
import type * as DockerEnvironment from "../../../src/onboarding/adapters/docker/environment.js";

const dockerBoundary = vi.hoisted(() => ({
  assertLocal: vi.fn<() => Promise<string>>(),
  deployments: [] as DeploymentOptions[],
  databaseEnvironments: [] as NodeJS.ProcessEnv[],
}));

vi.mock(
  "../../../src/onboarding/adapters/docker/environment.js",
  async (importOriginal) => {
    const original = await importOriginal<typeof DockerEnvironment>();
    return {
      ...original,
      assertLocalDockerContext: dockerBoundary.assertLocal,
    };
  },
);

vi.mock("../../../src/onboarding/adapters/docker/deployment.js", () => ({
  DeploymentAdapter: class {
    constructor(options: DeploymentOptions) {
      dockerBoundary.deployments.push(options);
    }
    async probe(): Promise<void> {
      await Promise.resolve();
    }
    async deploy(): Promise<void> {
      await Promise.resolve();
    }
  },
}));

vi.mock(
  "../../../src/onboarding/adapters/postgres/service-database.js",
  () => ({
    ServiceDatabase: class {
      constructor(options: { readonly environment: NodeJS.ProcessEnv }) {
        dockerBoundary.databaseEnvironments.push(options.environment);
      }
      async verifyVolume(): Promise<void> {
        await Promise.resolve();
      }
      async verifySchemaAndReadiness(): Promise<void> {
        await Promise.resolve();
      }
    },
  }),
);

import { continueProductionSetup } from "../../../src/onboarding/application/production-continuation.js";
import {
  InstallationSchema,
  type Installation,
} from "../../../src/onboarding/domain/installation.js";
import { OperationJournal } from "../../../src/onboarding/domain/operation-journal.js";
import { createOwnershipLedger } from "../../../src/onboarding/domain/ownership.js";
import { snapshotTree } from "../../helpers/filesystem-snapshot.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

async function protectedJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function persistedContinuation(options: {
  readonly fixture: OnboardingEnvironment;
  readonly state:
    "verified" | "external-verified" | "adapter-installed" | "none";
  readonly status?: "complete" | "data-retained";
}): Promise<{
  readonly installation: Installation;
  readonly stateRoot: string;
  readonly dataRoot: string;
  readonly launcherPath: string;
  readonly operationId: string;
}> {
  const installationId = randomUUID();
  const operationId = randomUUID();
  const stateRoot = resolve(options.fixture.xdgStateHome, "skillwire");
  const dataRoot = resolve(options.fixture.xdgDataHome, "skillwire");
  const launcherPath = resolve(options.fixture.root, "owned/bin/skillwire");
  const selected = options.state === "none" ? [] : (["codex"] as const);
  const integrationId = options.state === "none" ? null : randomUUID();
  const credentialId =
    options.state === "verified" || options.state === "adapter-installed"
      ? randomUUID()
      : null;
  const now = new Date().toISOString();
  const installation = InstallationSchema.parse({
    schemaVersion: "skillwire.installation/v1",
    installationId,
    ownerUid: process.getuid?.() ?? 1000,
    accountId: randomUUID(),
    activeReleaseId: "1-amd64",
    highestAcceptedReleaseSequence: 1,
    activeTrustPolicySequence: 1,
    endpoint: `unix://${resolve(options.fixture.runtimeRoot, "skillwire/mcp.sock")}`,
    composeProject: options.fixture.composeProject,
    postgresVolume: options.fixture.postgresVolume,
    selectedClients: selected,
    clientIntegrationIds: { codex: integrationId, claude: null },
    status: options.status ?? "complete",
    createdAt: now,
    updatedAt: now,
    lastValidatedAt: now,
  });
  await protectedJson(resolve(stateRoot, "deployment.json"), {
    schemaVersion: "skillwire.deployment/v1",
    installationId,
    releaseRoot: options.fixture.root,
    composePath: resolve(options.fixture.root, "compose.yaml"),
    skillwireImage: `example.invalid/skillwire@sha256:${"a".repeat(64)}`,
    postgresImage: `example.invalid/postgres@sha256:${"b".repeat(64)}`,
    databasePasswordFile: resolve(options.fixture.root, "database-password"),
    applicationPepperFile: resolve(options.fixture.root, "application-pepper"),
    runtimeSocketDirectory: resolve(options.fixture.runtimeRoot, "skillwire"),
    socketPath: resolve(options.fixture.runtimeRoot, "skillwire/mcp.sock"),
    projectName: options.fixture.composeProject,
    volumeName: options.fixture.postgresVolume,
  });
  await protectedJson(
    resolve(stateRoot, "installations", installationId, "bridge-state.json"),
    {
      schemaVersion: "skillwire.bridge-state/v1",
      installationId,
      transport: "unix-domain-socket",
      endpoint: "http://localhost/mcp",
      socketPath: resolve(options.fixture.runtimeRoot, "skillwire/mcp.sock"),
      clients:
        options.state === "verified" || options.state === "adapter-installed"
          ? [
              {
                client: "codex",
                credentialReference: "restrictive-file:codex",
                keyId: randomUUID(),
              },
            ]
          : [],
    },
  );
  await protectedJson(resolve(stateRoot, "credential-references.json"), {
    schemaVersion: "skillwire.credential-references/v1",
    installationId,
    credentials:
      credentialId === null
        ? []
        : [
            {
              schemaVersion: "skillwire.credential-reference/v1",
              credentialReferenceId: credentialId,
              installationId,
              client: "codex",
              backend: "restrictive-file",
              locator: "restrictive-file:codex",
              keyPublicIdHash: "c".repeat(64),
              createdByOperation: operationId,
              state: "available",
              fallbackRiskConfirmed: true,
            },
          ],
  });
  await protectedJson(resolve(stateRoot, "client-integrations.json"), {
    schemaVersion: "skillwire.client-integrations/v1",
    installationId,
    integrations:
      integrationId === null
        ? []
        : [
            {
              schemaVersion: "skillwire.client-integration/v1",
              clientIntegrationId: integrationId,
              installationId,
              client: "codex",
              clientVersion: "0.147.0",
              profileScope: "normal-user",
              state: options.state,
              credentialReferenceId: credentialId,
              keyPublicIdHash:
                options.state === "verified" ||
                options.state === "adapter-installed"
                  ? "c".repeat(64)
                  : null,
              mcpIdentitySha256: "d".repeat(64),
              adapterIdentitySha256: "e".repeat(64),
            },
          ],
  });
  await protectedJson(resolve(stateRoot, "external-integrations.json"), {
    schemaVersion: "skillwire.external-integrations/v1",
    installationId,
    dependencies: [],
  });
  await protectedJson(
    resolve(stateRoot, "ownership.json"),
    createOwnershipLedger(installationId).record,
  );
  return { installation, stateRoot, dataRoot, launcherPath, operationId };
}

describe("production setup continuation boundaries", () => {
  let fixture: OnboardingEnvironment | undefined;

  beforeEach(() => {
    dockerBoundary.assertLocal.mockReset();
    dockerBoundary.assertLocal.mockResolvedValue(
      "unix:///tmp/disposable-docker.sock",
    );
    dockerBoundary.deployments.length = 0;
    dockerBoundary.databaseEnvironments.length = 0;
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it.each(["verified", "external-verified"] as const)(
    "verifies a prior %s client before any newly requested client mutation",
    async (state) => {
      fixture = await createOnboardingEnvironment();
      const persisted = await persistedContinuation({ fixture, state });
      const verifyPriorSelectedClients = vi
        .fn<(clients: readonly ("codex" | "claude")[]) => Promise<void>>()
        .mockRejectedValue(new Error("prior selected client drifted"));
      const journal = await OperationJournal.create(
        resolve(persisted.stateRoot, "operations"),
        persisted.operationId,
        "setup",
      );
      const before = await snapshotTree(fixture.root);

      await expect(
        continueProductionSetup({
          setup: { clients: "claude" },
          credentialBackend: "restrictive-file",
          installation: persisted.installation,
          home: fixture.home,
          dataRoot: persisted.dataRoot,
          stateRoot: persisted.stateRoot,
          runtimeRoot: fixture.runtimeRoot,
          launcherPath: persisted.launcherPath,
          environment: fixture.environment,
          signal: new AbortController().signal,
          journal,
          verifyPriorSelectedClients,
        }),
      ).rejects.toThrow(/prior selected client drifted/i);

      expect(verifyPriorSelectedClients).toHaveBeenCalledOnce();
      expect(verifyPriorSelectedClients).toHaveBeenCalledWith(
        ["codex"],
        expect.objectContaining({
          DOCKER_HOST: "unix:///tmp/disposable-docker.sock",
        }),
      );
      expect(journal.entries).toEqual([]);
      expect(await snapshotTree(fixture.root)).toEqual(before);
    },
  );

  it("keeps an external prior integration credential-free during verification", async () => {
    fixture = await createOnboardingEnvironment();
    const persisted = await persistedContinuation({
      fixture,
      state: "external-verified",
    });
    const verifyPriorSelectedClients = vi.fn(() => Promise.resolve());
    const journal = await OperationJournal.create(
      resolve(persisted.stateRoot, "operations"),
      persisted.operationId,
      "setup",
    );

    const result = await continueProductionSetup({
      setup: { clients: "none" },
      credentialBackend: "not-selected",
      installation: persisted.installation,
      home: fixture.home,
      dataRoot: persisted.dataRoot,
      stateRoot: persisted.stateRoot,
      runtimeRoot: fixture.runtimeRoot,
      launcherPath: persisted.launcherPath,
      environment: fixture.environment,
      signal: new AbortController().signal,
      journal,
      verifyPriorSelectedClients,
    });

    expect(result).toMatchObject({ status: "success", serviceReady: true });
    expect(result.clients).toEqual([
      expect.objectContaining({
        client: "codex",
        status: "external-verified",
        owned: false,
      }),
    ]);
    expect(verifyPriorSelectedClients).toHaveBeenCalledWith(
      ["codex"],
      expect.objectContaining({
        DOCKER_HOST: "unix:///tmp/disposable-docker.sock",
      }),
    );
    await expect(
      lstat(resolve(persisted.dataRoot, "credentials")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never promotes an unverified prior integration from persisted metadata", async () => {
    fixture = await createOnboardingEnvironment();
    const persisted = await persistedContinuation({
      fixture,
      state: "adapter-installed",
    });
    const verifyPriorSelectedClients = vi.fn(() => Promise.resolve());
    const journal = await OperationJournal.create(
      resolve(persisted.stateRoot, "operations"),
      persisted.operationId,
      "setup",
    );

    await expect(
      continueProductionSetup({
        setup: { clients: "none" },
        credentialBackend: "restrictive-file",
        installation: persisted.installation,
        home: fixture.home,
        dataRoot: persisted.dataRoot,
        stateRoot: persisted.stateRoot,
        runtimeRoot: fixture.runtimeRoot,
        launcherPath: persisted.launcherPath,
        environment: { ...fixture.environment, PATH: fixture.repository },
        signal: new AbortController().signal,
        journal,
        verifyPriorSelectedClients,
      }),
    ).rejects.toThrow(/codex.*unavailable/i);

    expect(verifyPriorSelectedClients).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        DOCKER_HOST: "unix:///tmp/disposable-docker.sock",
      }),
    );
  });

  it("rejects a remote named Docker context before any continuation effect", async () => {
    fixture = await createOnboardingEnvironment();
    const persisted = await persistedContinuation({
      fixture,
      state: "verified",
    });
    dockerBoundary.assertLocal.mockRejectedValueOnce(
      new Error(
        "A local Docker context is required; remote contexts are refused",
      ),
    );
    const journal = await OperationJournal.create(
      resolve(persisted.stateRoot, "operations"),
      persisted.operationId,
      "setup",
    );
    const before = await snapshotTree(fixture.root);
    const verifyPriorSelectedClients = vi.fn(() => Promise.resolve());

    await expect(
      continueProductionSetup({
        setup: { clients: "none" },
        credentialBackend: "not-selected",
        installation: persisted.installation,
        home: fixture.home,
        dataRoot: persisted.dataRoot,
        stateRoot: persisted.stateRoot,
        runtimeRoot: fixture.runtimeRoot,
        launcherPath: persisted.launcherPath,
        environment: {
          ...fixture.environment,
          DOCKER_CONTEXT: "remote-production",
        },
        signal: new AbortController().signal,
        journal,
        verifyPriorSelectedClients,
      }),
    ).rejects.toThrow(/local Docker context|remote/i);

    expect(verifyPriorSelectedClients).not.toHaveBeenCalled();
    expect(journal.entries).toEqual([]);
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  it("pins an accepted named Docker context for retained-service Docker effects", async () => {
    fixture = await createOnboardingEnvironment();
    const persisted = await persistedContinuation({
      fixture,
      state: "none",
      status: "data-retained",
    });
    const journal = await OperationJournal.create(
      resolve(persisted.stateRoot, "operations"),
      persisted.operationId,
      "setup",
    );

    await continueProductionSetup({
      setup: { clients: "none" },
      credentialBackend: "not-selected",
      installation: persisted.installation,
      home: fixture.home,
      dataRoot: persisted.dataRoot,
      stateRoot: persisted.stateRoot,
      runtimeRoot: fixture.runtimeRoot,
      launcherPath: persisted.launcherPath,
      environment: {
        ...fixture.environment,
        DOCKER_CONTEXT: "rootless-local",
      },
      signal: new AbortController().signal,
      journal,
      verifyPriorSelectedClients: vi.fn(() => Promise.resolve()),
    });

    expect(dockerBoundary.deployments).toHaveLength(1);
    expect(dockerBoundary.deployments[0]?.hostEnvironment).toMatchObject({
      DOCKER_HOST: "unix:///tmp/disposable-docker.sock",
    });
    expect(dockerBoundary.deployments[0]?.hostEnvironment).not.toHaveProperty(
      "DOCKER_CONTEXT",
    );
    expect(dockerBoundary.databaseEnvironments).toHaveLength(1);
    expect(dockerBoundary.databaseEnvironments[0]).toMatchObject({
      DOCKER_HOST: "unix:///tmp/disposable-docker.sock",
    });
    expect(dockerBoundary.databaseEnvironments[0]).not.toHaveProperty(
      "DOCKER_CONTEXT",
    );
  });
});
