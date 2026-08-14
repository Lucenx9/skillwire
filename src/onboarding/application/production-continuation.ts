import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { atomicWriteJson } from "../adapters/filesystem/atomic-state.js";
import { CodexClientAdapter } from "../adapters/clients/codex.js";
import { ClaudeClientAdapter } from "../adapters/clients/claude.js";
import { clientComponentIdentity } from "../adapters/clients/client-state.js";
import { DeploymentAdapter } from "../adapters/docker/deployment.js";
import { dockerProcessEnvironment } from "../adapters/docker/environment.js";
import { SecretToolCredentialStore } from "../adapters/credentials/secret-tool.js";
import {
  RestrictiveFileCredentialStore,
  type RestrictiveFileReference,
} from "../adapters/credentials/restrictive-file.js";
import {
  ClientKeyHandoffRecoveryError,
  createClientKeyInAdminContainer,
  revokeClientKeyInAdminContainer,
} from "../adapters/postgres/bootstrap-admin.js";
import { ServiceDatabase } from "../adapters/postgres/service-database.js";
import type { ClientName } from "../cli/main.js";
import { ClientMutationNotStartedError } from "../domain/client-mutation.js";
import {
  ClientIntegrationSchema,
  CredentialReferenceSchema,
  InstallationSchema,
  transitionInstallation,
  type Installation,
} from "../domain/installation.js";
import type { OperationJournal } from "../domain/operation-journal.js";
import {
  ExternalIntegrationDependencySchema,
  reactivateOwnedAsset,
  recordExternalIntegration,
  recordOwnedAsset,
  verifyOwnershipRecord,
  type OwnershipLedger,
} from "../domain/ownership.js";
import {
  clientConflictFinding,
  ClientProvisioningRecoveryError,
  installClientLifecycle,
} from "./client-lifecycle.js";
import { verifyClientIntegration } from "./client-verification.js";
import type {
  GuidedSetupOptions,
  GuidedSetupResult,
  SetupClientResult,
} from "./setup.js";

const DeploymentStateSchema = z
  .object({
    schemaVersion: z.literal("skillwire.deployment/v1"),
    installationId: z.uuid(),
    releaseRoot: z.string().refine(isAbsolute),
    composePath: z.string().refine(isAbsolute),
    skillwireImage: z.string().min(1),
    postgresImage: z.string().min(1),
    databasePasswordFile: z.string().refine(isAbsolute),
    applicationPepperFile: z.string().refine(isAbsolute),
    runtimeSocketDirectory: z.string().refine(isAbsolute),
    socketPath: z.string().refine(isAbsolute),
    projectName: z.string().min(1),
    volumeName: z.string().min(1),
  })
  .strict();

const BridgeStateSchema = z
  .object({
    schemaVersion: z.literal("skillwire.bridge-state/v1"),
    installationId: z.uuid(),
    transport: z.literal("unix-domain-socket"),
    endpoint: z.literal("http://localhost/mcp"),
    socketPath: z.string().refine(isAbsolute),
    clients: z.array(
      z
        .object({
          client: z.enum(["codex", "claude"]),
          credentialReference: z.string().min(1),
          keyId: z.uuid(),
        })
        .strict(),
    ),
  })
  .strict();

const CredentialStateSchema = z
  .object({
    schemaVersion: z.literal("skillwire.credential-references/v1"),
    installationId: z.uuid(),
    credentials: z.array(CredentialReferenceSchema),
  })
  .strict();

const IntegrationStateSchema = z
  .object({
    schemaVersion: z.literal("skillwire.client-integrations/v1"),
    installationId: z.uuid(),
    integrations: z.array(ClientIntegrationSchema),
  })
  .strict();

const ExternalStateSchema = z
  .object({
    schemaVersion: z.literal("skillwire.external-integrations/v1"),
    installationId: z.uuid(),
    dependencies: z.array(ExternalIntegrationDependencySchema),
  })
  .strict();

type CredentialBackend = "secret-service" | "restrictive-file" | "not-selected";

async function readProtectedJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > 1024 * 1024
    )
      throw new Error("Retained setup state is unsafe");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

function selectedClients(
  selection: GuidedSetupOptions["clients"],
): readonly ClientName[] {
  if (selection === "none") return [];
  return selection === "codex,claude" ? ["codex", "claude"] : [selection];
}

async function executable(
  client: ClientName,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  for (const directory of (
    environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"
  )
    .split(":")
    .filter(isAbsolute)) {
    const candidate = resolve(directory, client);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the bounded normal-profile PATH.
    }
  }
  throw new Error(`Supported ${client} client executable is unavailable`);
}

function composeEnvironment(
  deployment: z.infer<typeof DeploymentStateSchema>,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return dockerProcessEnvironment(environment, {
    SKILLWIRE_COMPOSE_PROJECT: deployment.projectName,
    SKILLWIRE_POSTGRES_VOLUME: deployment.volumeName,
    SKILLWIRE_IMAGE: deployment.skillwireImage,
    SKILLWIRE_POSTGRES_IMAGE: deployment.postgresImage,
    SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE: deployment.databasePasswordFile,
    SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE: deployment.applicationPepperFile,
    SKILLWIRE_RUNTIME_SOCKET_DIRECTORY: deployment.runtimeSocketDirectory,
    SKILLWIRE_RUNTIME_UID: String(process.getuid?.() ?? 10001),
    SKILLWIRE_RUNTIME_GID: String(process.getgid?.() ?? 10001),
  });
}

export async function continueProductionSetup(options: {
  readonly setup: GuidedSetupOptions;
  readonly credentialBackend: CredentialBackend;
  readonly installation: Installation;
  readonly home: string;
  readonly dataRoot: string;
  readonly stateRoot: string;
  readonly runtimeRoot: string;
  readonly launcherPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly journal: OperationJournal;
}): Promise<GuidedSetupResult> {
  const { installation, stateRoot, dataRoot, environment, signal, journal } =
    options;
  const deployment = DeploymentStateSchema.parse(
    await readProtectedJson(resolve(stateRoot, "deployment.json")),
  );
  const bridgePath = resolve(
    stateRoot,
    "installations",
    installation.installationId,
    "bridge-state.json",
  );
  const bridge = BridgeStateSchema.parse(await readProtectedJson(bridgePath));
  const credentials = CredentialStateSchema.parse(
    await readProtectedJson(resolve(stateRoot, "credential-references.json")),
  );
  const integrations = IntegrationStateSchema.parse(
    await readProtectedJson(resolve(stateRoot, "client-integrations.json")),
  );
  const external = ExternalStateSchema.parse(
    await readProtectedJson(resolve(stateRoot, "external-integrations.json")),
  );
  let ownership = verifyOwnershipRecord(
    await readProtectedJson(resolve(stateRoot, "ownership.json")),
  );
  if (
    [
      deployment.installationId,
      bridge.installationId,
      credentials.installationId,
      integrations.installationId,
      external.installationId,
      ownership.installationId,
    ].some((value) => value !== installation.installationId)
  )
    throw new Error("Retained setup installation identities differ");

  const dockerEnvironment = composeEnvironment(deployment, environment);
  if (installation.status === "data-retained") {
    const adapter = new DeploymentAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: deployment.composePath,
      projectName: deployment.projectName,
      volumeName: deployment.volumeName,
      skillwireImage: deployment.skillwireImage,
      postgresImage: deployment.postgresImage,
      databasePasswordFile: deployment.databasePasswordFile,
      applicationPepperFile: deployment.applicationPepperFile,
      runtimeSocketDirectory: deployment.runtimeSocketDirectory,
      socketPath: deployment.socketPath,
      hostEnvironment: environment,
    });
    await journal.runEffect({
      step: "retained-service-reactivation",
      intent: { installationId: installation.installationId },
      signal,
      action: async () => {
        await adapter.probe(signal);
        await adapter.deploy(signal);
        const database = new ServiceDatabase({
          dockerExecutable: "/usr/bin/docker",
          projectName: deployment.projectName,
          volumeName: deployment.volumeName,
          composePath: deployment.composePath,
          environment: dockerEnvironment,
        });
        await database.verifyVolume(signal);
        await database.verifySchemaAndReadiness(signal);
      },
      verification: () => ({ retainedServiceReady: true }),
    });
    for (const asset of ownership.assets.filter(
      ({ kind, disposition }) =>
        (kind === "compose-project" || kind === "container") &&
        disposition === "removed",
    ))
      ownership = reactivateOwnedAsset(
        ownership,
        asset.assetId,
        asset.expectedIdentitySha256,
      );
  }

  const bridgeClients = [...bridge.clients];
  const nextCredentials = [...credentials.credentials];
  const nextIntegrations = [...integrations.integrations];
  let ledger: OwnershipLedger = {
    record: ownership,
    externalIntegrations: [...external.dependencies],
  };
  const requested = selectedClients(options.setup.clients);
  const clientsToEnsure =
    installation.status === "data-retained"
      ? [...requested]
      : Array.from(new Set([...installation.selectedClients, ...requested]));
  const clientResults: SetupClientResult[] = [];
  for (const client of clientsToEnsure) {
    const priorIntegration = nextIntegrations.find(
      (entry) => entry.client === client,
    );
    const mustReconcile =
      installation.status === "data-retained" ||
      priorIntegration === undefined ||
      priorIntegration.state === "failed" ||
      priorIntegration.state === "removed" ||
      priorIntegration.state === "retained-external";
    if (!mustReconcile) {
      clientResults.push({
        client,
        status:
          priorIntegration.state === "external-verified"
            ? "external-verified"
            : "verified",
        compensated: false,
        owned: priorIntegration.state !== "external-verified",
      });
      continue;
    }
    const secretService = new SecretToolCredentialStore(
      "/usr/bin/secret-tool",
      environment,
    );
    const fallback = new RestrictiveFileCredentialStore(
      dataRoot,
      dataRoot,
      installation.installationId,
    );
    const existingBridge = bridgeClients.find(
      (entry) => entry.client === client,
    );
    let currentReference = existingBridge?.credentialReference;
    let currentKeyId = existingBridge?.keyId;
    let createdCredential = false;
    const vendorExecutable = await executable(client, environment);
    const adapter =
      client === "codex"
        ? new CodexClientAdapter(vendorExecutable, environment, signal)
        : new ClaudeClientAdapter(
            vendorExecutable,
            environment,
            undefined,
            undefined,
            signal,
          );
    const marketplacePath = resolve(
      deployment.releaseRoot,
      client === "codex"
        ? "distribution/codex-release-marketplace"
        : "distribution/claude-marketplace",
    );
    const persistBridge = () =>
      atomicWriteJson(
        bridgePath,
        { ...bridge, clients: bridgeClients },
        stateRoot,
      );
    const lifecycle = await installClientLifecycle(client, {
      preflight: async () => {
        const ownedMcpIdentity = ledger.record.assets.find(
          (asset) =>
            asset.kind === "mcp-entry" &&
            asset.client === client &&
            asset.disposition === "present",
        )?.expectedIdentitySha256;
        const [mcpState, pluginState] = await Promise.all([
          adapter.reconcileMcp(
            options.launcherPath,
            installation.installationId,
            ownedMcpIdentity,
          ),
          adapter.reconcilePlugin(marketplacePath),
        ]);
        const blocked = [mcpState, pluginState].find(
          ({ classification }) =>
            classification !== "absent" &&
            classification !== "owned-equivalent" &&
            classification !== "external-equivalent",
        );
        if (blocked !== undefined)
          return {
            action: "block" as const,
            classification: blocked.classification as Exclude<
              typeof blocked.classification,
              "absent" | "owned-equivalent" | "external-equivalent"
            >,
            ...(blocked.observations[0] === undefined
              ? {}
              : {
                  finding: clientConflictFinding(
                    client,
                    blocked === mcpState ? "mcp-entry" : "plugin",
                    blocked.classification,
                    blocked.observations[0],
                  ),
                }),
          };
        return {
          action:
            mcpState.classification === "external-equivalent" &&
            pluginState.classification === "external-equivalent"
              ? ("reuse-external" as const)
              : ("proceed" as const),
          mcp:
            mcpState.classification === "absent"
              ? ("create" as const)
              : mcpState.classification === "owned-equivalent"
                ? ("reuse-owned" as const)
                : ("reuse-external" as const),
          plugin:
            pluginState.classification === "absent"
              ? ("create" as const)
              : pluginState.classification === "owned-equivalent"
                ? ("reuse-owned" as const)
                : ("reuse-external" as const),
        };
      },
      provisionCredential: async () => {
        if (currentReference !== undefined && currentKeyId !== undefined)
          return { keyId: currentKeyId, reference: currentReference };
        if (options.credentialBackend === "not-selected")
          throw new Error("A selected client requires a credential backend");
        const key = await journal
          .runEffect({
            step: `continued-client-${client}-key`,
            intent: { client, accountId: installation.accountId },
            signal,
            action: () =>
              createClientKeyInAdminContainer({
                client,
                dockerExecutable: "/usr/bin/docker",
                composePath: deployment.composePath,
                projectName: deployment.projectName,
                accountId: installation.accountId,
                runtimeRoot: options.runtimeRoot,
                environment: dockerEnvironment,
                signal,
              }),
            verification: (value) => ({ client, keyId: value.keyId }),
          })
          .catch((error: unknown) => {
            if (error instanceof ClientKeyHandoffRecoveryError)
              throw new ClientProvisioningRecoveryError(error.message);
            throw error;
          });
        currentKeyId = key.keyId;
        try {
          const stored = await journal.runEffect({
            step: `continued-client-${client}-credential`,
            intent: { client, backend: options.credentialBackend },
            signal,
            action: async () => {
              currentReference =
                options.credentialBackend === "secret-service"
                  ? (
                      await secretService.store(
                        installation.installationId,
                        client,
                        key.token,
                        signal,
                      )
                    ).reference
                  : await fallback.store(client, key.token, true);
              const readback = currentReference.startsWith("secret-service:")
                ? await secretService.lookup(
                    installation.installationId,
                    client,
                    currentReference,
                    signal,
                  )
                : await fallback.lookup(
                    currentReference as RestrictiveFileReference,
                  );
              if (
                readback.length !== key.token.length ||
                !timingSafeEqual(Buffer.from(readback), Buffer.from(key.token))
              )
                throw new Error("Continued setup credential readback failed");
              bridgeClients.push({
                client,
                credentialReference: currentReference,
                keyId: key.keyId,
              });
              await persistBridge();
              return { keyId: key.keyId, reference: currentReference };
            },
            verification: (value) => ({ client, reference: value.reference }),
          });
          createdCredential = true;
          return stored;
        } catch (error) {
          await revokeClientKeyInAdminContainer({
            dockerExecutable: "/usr/bin/docker",
            composePath: deployment.composePath,
            projectName: deployment.projectName,
            keyId: key.keyId,
            environment: dockerEnvironment,
            signal: AbortSignal.timeout(30_000),
          }).catch(() => undefined);
          throw error;
        }
      },
      addMcp: () =>
        journal.runEffect({
          step: `continued-client-${client}-mcp`,
          intent: { client },
          signal,
          action: () =>
            adapter.addMcp(options.launcherPath, installation.installationId),
          effectNotStarted: (error) =>
            error instanceof ClientMutationNotStartedError,
          verification: () => ({ client, installed: true }),
        }),
      addPlugin: () =>
        adapter.addPlugin(marketplacePath, (component, action) =>
          journal.runEffect({
            step: `continued-client-${client}-${component}`,
            intent: { client, component },
            signal,
            action,
            verification: () => ({ client, component, installed: true }),
          }),
        ),
      verify: async () => {
        await verifyClientIntegration({
          client,
          vendorExecutable,
          installationId: installation.installationId,
          registration: await adapter.readMcp(),
          expectedLauncher: options.launcherPath,
          environment,
          inventory: () => adapter.readInventory(marketplacePath),
          signal,
        });
      },
      removePlugin: async () => {
        const recoveryAdapter =
          client === "codex"
            ? new CodexClientAdapter(
                vendorExecutable,
                environment,
                AbortSignal.timeout(30_000),
              )
            : new ClaudeClientAdapter(
                vendorExecutable,
                environment,
                undefined,
                undefined,
                AbortSignal.timeout(30_000),
              );
        await recoveryAdapter.removePlugin(marketplacePath);
      },
      removeMcp: async () => {
        const recoveryAdapter =
          client === "codex"
            ? new CodexClientAdapter(
                vendorExecutable,
                environment,
                AbortSignal.timeout(30_000),
              )
            : new ClaudeClientAdapter(
                vendorExecutable,
                environment,
                undefined,
                undefined,
                AbortSignal.timeout(30_000),
              );
        await recoveryAdapter.removeMcp();
      },
      revokeCredential: async (keyId, reference) => {
        if (!createdCredential) return;
        await revokeClientKeyInAdminContainer({
          dockerExecutable: "/usr/bin/docker",
          composePath: deployment.composePath,
          projectName: deployment.projectName,
          keyId,
          environment: dockerEnvironment,
          signal: AbortSignal.timeout(30_000),
        });
        if (reference.startsWith("secret-service:"))
          await secretService.clear(
            installation.installationId,
            client,
            reference,
            AbortSignal.timeout(30_000),
          );
        else await fallback.remove(reference as RestrictiveFileReference);
      },
      profileSnapshot: {
        client,
        profileRoot: options.home,
        stateRoot: dirname(stateRoot),
        relativePaths:
          client === "codex"
            ? [".codex/config.toml"]
            : [".claude.json", ".claude/settings.json"],
      },
      mcpProfilePaths:
        client === "codex" ? [".codex/config.toml"] : [".claude.json"],
      pluginProfilePaths:
        client === "codex"
          ? [".codex/config.toml"]
          : [".claude.json", ".claude/settings.json"],
    });
    clientResults.push(lifecycle);
    if (
      lifecycle.status !== "verified" &&
      lifecycle.status !== "external-verified"
    )
      continue;
    const integrationId = priorIntegration?.clientIntegrationId ?? randomUUID();
    const credential = nextCredentials.find((entry) => entry.client === client);
    const credentialReferenceId =
      currentReference === undefined || currentKeyId === undefined
        ? null
        : (credential?.credentialReferenceId ?? randomUUID());
    const mcpIdentity = clientComponentIdentity({
      command: options.launcherPath,
      args: [
        "bridge",
        "--installation",
        installation.installationId,
        "--client",
        client,
      ],
      scope: "user",
    });
    const pluginIdentity = clientComponentIdentity({
      plugin: "skillwire-autonomous-activation@skillwire",
      marketplacePath,
    });
    const integration = ClientIntegrationSchema.parse({
      schemaVersion: "skillwire.client-integration/v1",
      clientIntegrationId: integrationId,
      installationId: installation.installationId,
      client,
      clientVersion: client === "codex" ? "0.147.0" : "2.1.229",
      profileScope: "normal-user",
      state: lifecycle.status,
      credentialReferenceId,
      keyPublicIdHash:
        currentKeyId === undefined
          ? null
          : createHash("sha256").update(currentKeyId).digest("hex"),
      mcpIdentitySha256: mcpIdentity,
      adapterIdentitySha256: pluginIdentity,
    });
    const integrationIndex = nextIntegrations.findIndex(
      (entry) => entry.client === client,
    );
    if (integrationIndex < 0) nextIntegrations.push(integration);
    else nextIntegrations[integrationIndex] = integration;
    if (
      credentialReferenceId !== null &&
      currentReference !== undefined &&
      currentKeyId !== undefined
    ) {
      const nextCredential = CredentialReferenceSchema.parse({
        schemaVersion: "skillwire.credential-reference/v1",
        credentialReferenceId,
        installationId: installation.installationId,
        client,
        backend: currentReference.startsWith("secret-service:")
          ? "secret-service"
          : "restrictive-file",
        locator: currentReference,
        keyPublicIdHash: createHash("sha256")
          .update(currentKeyId)
          .digest("hex"),
        createdByOperation:
          credential?.createdByOperation ?? journal.operationId,
        state: "available",
        fallbackRiskConfirmed: !currentReference.startsWith("secret-service:"),
      });
      const credentialIndex = nextCredentials.findIndex(
        (entry) => entry.client === client,
      );
      if (credentialIndex < 0) nextCredentials.push(nextCredential);
      else nextCredentials[credentialIndex] = nextCredential;
      const retainedAsset = ledger.record.assets.find(
        (asset) =>
          asset.kind === "credential" &&
          asset.client === client &&
          asset.locator === currentReference &&
          asset.disposition === "retained",
      );
      if (retainedAsset !== undefined)
        ledger = {
          ...ledger,
          record: reactivateOwnedAsset(
            ledger.record,
            retainedAsset.assetId,
            retainedAsset.expectedIdentitySha256,
          ),
        };
      else if (existingBridge === undefined)
        ledger = recordOwnedAsset(ledger, {
          kind: "credential",
          client,
          locator: currentReference,
          expectedIdentitySha256: clientComponentIdentity({
            reference: currentReference,
          }),
          createdByOperation: journal.operationId,
          retention: "retain-by-default",
          disposition: "present",
        });
    }
    for (const [component, state, identity, locator] of [
      ["mcp-entry", lifecycle.components.mcp, mcpIdentity, "skillwire:user"],
      [
        "marketplace",
        lifecycle.components.plugin,
        pluginIdentity,
        `skillwire:${marketplacePath}`,
      ],
      [
        "plugin",
        lifecycle.components.plugin,
        pluginIdentity,
        "skillwire-autonomous-activation@skillwire",
      ],
    ] as const) {
      if (state === "created")
        ledger = recordOwnedAsset(ledger, {
          kind: component,
          client,
          locator,
          expectedIdentitySha256: identity,
          createdByOperation: journal.operationId,
          retention: "remove-on-uninstall",
          disposition: "present",
        });
      else if (
        state === "external" &&
        !ledger.externalIntegrations.some(
          (entry) => entry.client === client && entry.kind === component,
        )
      )
        ledger = recordExternalIntegration(ledger, {
          schemaVersion: "skillwire.external-integration/v1",
          externalDependencyId: randomUUID(),
          client,
          kind: component,
          scope: "user",
          observedIdentitySha256: identity,
          verification: "equivalent",
          lastObservedAt: new Date().toISOString(),
        });
    }
  }

  const status = clientResults.some(
    ({ status: state }) => state === "recovery-required",
  )
    ? "recovery-required"
    : clientResults.some(
          ({ status: state }) =>
            state !== "verified" && state !== "external-verified",
        )
      ? "incomplete"
      : "success";
  const timestamp = new Date().toISOString();
  const selected =
    installation.status === "data-retained"
      ? [...requested]
      : Array.from(new Set([...installation.selectedClients, ...requested]));
  let nextInstallation: Installation = {
    ...installation,
    selectedClients: selected,
    clientIntegrationIds: {
      codex: selected.includes("codex")
        ? (nextIntegrations.find(({ client }) => client === "codex")
            ?.clientIntegrationId ?? null)
        : null,
      claude: selected.includes("claude")
        ? (nextIntegrations.find(({ client }) => client === "claude")
            ?.clientIntegrationId ?? null)
        : null,
    },
    status: installation.status,
    updatedAt: timestamp,
  };
  if (installation.status === "data-retained")
    nextInstallation = transitionInstallation(
      nextInstallation,
      "service-ready",
    );
  const targetStatus =
    status === "recovery-required"
      ? ("recovery-required" as const)
      : status === "incomplete"
        ? ("incomplete" as const)
        : selected.length === 0
          ? ("service-ready" as const)
          : ("complete" as const);
  nextInstallation =
    nextInstallation.status === targetStatus
      ? {
          ...nextInstallation,
          updatedAt: timestamp,
          lastValidatedAt:
            targetStatus === "complete" || targetStatus === "service-ready"
              ? timestamp
              : nextInstallation.lastValidatedAt,
        }
      : transitionInstallation(nextInstallation, targetStatus);
  await journal.runEffect({
    step: "continued-setup-state-publication",
    intent: { installationId: installation.installationId, status },
    signal,
    action: async () => {
      await atomicWriteJson(
        resolve(stateRoot, "ownership.json"),
        ledger.record,
        stateRoot,
      );
      await atomicWriteJson(
        resolve(stateRoot, "external-integrations.json"),
        { ...external, dependencies: ledger.externalIntegrations },
        stateRoot,
      );
      await atomicWriteJson(
        resolve(stateRoot, "credential-references.json"),
        { ...credentials, credentials: nextCredentials },
        stateRoot,
      );
      await atomicWriteJson(
        resolve(stateRoot, "client-integrations.json"),
        { ...integrations, integrations: nextIntegrations },
        stateRoot,
      );
      await atomicWriteJson(
        bridgePath,
        { ...bridge, clients: bridgeClients },
        stateRoot,
      );
      await atomicWriteJson(
        resolve(stateRoot, "installation.json"),
        InstallationSchema.parse(nextInstallation),
        stateRoot,
      );
    },
    verification: () => ({
      installationId: installation.installationId,
      published: true,
    }),
  });
  return {
    status,
    installationId: installation.installationId,
    serviceReady: true,
    clients: clientResults,
  };
}
