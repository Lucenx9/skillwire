import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

import type { AdministrativeOperations } from "../cli/command-router.js";
import type { ParsedCommand } from "../cli/main.js";
import { AdminResultSchema, type AdminResult } from "../cli/output.js";
import { canonicalPreview, confirmPreview } from "../cli/confirmation.js";
import { atomicWriteJson } from "../adapters/filesystem/atomic-state.js";
import { clientComponentIdentity } from "../adapters/clients/client-state.js";
import { DeploymentAdapter } from "../adapters/docker/deployment.js";
import {
  assertLocalDockerContext,
  dockerProcessEnvironment,
  pinLocalDockerEndpoint,
} from "../adapters/docker/environment.js";
import { CodexClientAdapter } from "../adapters/clients/codex.js";
import { ClaudeClientAdapter } from "../adapters/clients/claude.js";
import { SecretToolCredentialStore } from "../adapters/credentials/secret-tool.js";
import {
  RestrictiveFileCredentialStore,
  type RestrictiveFileReference,
} from "../adapters/credentials/restrictive-file.js";
import {
  createClientKeyInAdminContainer,
  revokeClientKeyInAdminContainer,
} from "../adapters/postgres/bootstrap-admin.js";
import { ServiceDatabase } from "../adapters/postgres/service-database.js";
import { runCommand } from "../adapters/process/command-runner.js";
import {
  ClientIntegrationSchema,
  CredentialReferenceSchema,
  InstallationSchema,
  ServiceSecretSetSchema,
  transitionClientIntegration,
  transitionInstallation,
} from "../domain/installation.js";
import {
  recordAssetDisposition,
  recordOwnedAsset,
  planOwnedAssetDispositions,
  reactivateOwnedAsset,
  replaceOwnedAssetIdentity,
  verifyOwnershipRecord,
  type OwnershipRecordSchema,
} from "../domain/ownership.js";
import {
  currentProcessIdentity,
  InstallationLock,
  OperationJournal,
} from "../domain/operation-journal.js";
import { PostgresBackupAdapter } from "../adapters/postgres/backup.js";
import {
  assessRestoredDatabaseEvidence,
  databaseStateExpectation,
  expectedMigrationInventory,
  readDatabaseEvidence,
  validateRestoredDatabaseContainer,
} from "../adapters/postgres/restore-validation.js";
import {
  installVerifiedRelease,
  releaseDirectoryIdentity,
} from "../adapters/filesystem/release-installer.js";
import { ReleaseManifestSchema } from "../domain/release-manifest.js";
import {
  ownedLauncherIdentity,
  previewProductionSetup,
} from "./production-setup.js";
import {
  diagnosticProbe,
  runDiagnosticProbes,
  type DiagnosticProbe,
} from "./diagnostic-probes.js";
import { runDoctor } from "./doctor.js";
import { inspectInstalledStatus } from "./status.js";
import { planRepair, runRepair, type RepairAsset } from "./repair.js";
import {
  ClientCredentialService,
  type ClientCredentialBackend,
} from "./client-credentials.js";
import {
  previewServiceSecretRotation,
  rotateServiceSecret,
} from "./service-secret-rotation.js";
import { backupDirectoryIdentity, createValidatedBackup } from "./backup.js";
import { drainWriters } from "../adapters/docker/writer-drain.js";
import {
  previewUpgrade,
  runUpgrade,
  upgradeFailureRequiresRecovery,
  UpgradeRecoveryError,
} from "./upgrade.js";
import { upgradeRecoveryGuidance } from "./upgrade-recovery.js";
import { uninstallClientLifecycle } from "./client-lifecycle.js";
import { previewDefaultUninstall, runDefaultUninstall } from "./uninstall.js";
import { journalNeedsRecovery, recoverOperation } from "./recovery.js";
import {
  previewPurge,
  removeOwnedFilesystemTree,
  runPurge,
  validateOwnedFilesystemTree,
} from "./purge.js";

type OwnershipRecord = z.infer<typeof OwnershipRecordSchema>;
type OwnedAsset = OwnershipRecord["assets"][number];

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
          keyId: z.uuid().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const CredentialReferencesStateSchema = z
  .object({
    schemaVersion: z.literal("skillwire.credential-references/v1"),
    installationId: z.uuid(),
    credentials: z.array(CredentialReferenceSchema),
  })
  .strict();

const ClientIntegrationsStateSchema = z
  .object({
    schemaVersion: z.literal("skillwire.client-integrations/v1"),
    installationId: z.uuid(),
    integrations: z.array(ClientIntegrationSchema),
  })
  .strict();

interface LifecycleRoots {
  readonly home: string;
  readonly stateRoot: string;
  readonly dataRoot: string;
  readonly runtimeRoot: string;
}

function rootsFor(
  command: ParsedCommand,
  environment: NodeJS.ProcessEnv,
): LifecycleRoots {
  const home = environment["HOME"];
  const dataHome =
    environment["XDG_DATA_HOME"] ??
    (home === undefined ? undefined : resolve(home, ".local/share"));
  const stateHome =
    environment["XDG_STATE_HOME"] ??
    (home === undefined ? undefined : resolve(home, ".local/state"));
  const runtimeHome = environment["XDG_RUNTIME_DIR"];
  if (
    home === undefined ||
    dataHome === undefined ||
    stateHome === undefined ||
    runtimeHome === undefined ||
    !isAbsolute(home) ||
    !isAbsolute(dataHome) ||
    !isAbsolute(stateHome) ||
    !isAbsolute(runtimeHome)
  )
    throw new Error(
      "Absolute HOME and XDG data/state/runtime roots are required for lifecycle operations",
    );
  const stateRoot = command.stateRoot ?? resolve(stateHome, "skillwire");
  const dataRoot = resolve(dataHome, "skillwire");
  const runtimeRoot = resolve(runtimeHome, "skillwire");
  if (!isAbsolute(stateRoot))
    throw new Error("Lifecycle state root must be absolute");
  return { home, stateRoot, dataRoot, runtimeRoot };
}

async function readProtectedJson(
  path: string,
  maximum = 1024 * 1024,
): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > maximum
    )
      throw new Error("Protected lifecycle state is unsafe");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

async function ownershipAt(stateRoot: string): Promise<OwnershipRecord> {
  return verifyOwnershipRecord(
    await readProtectedJson(resolve(stateRoot, "ownership.json")),
  );
}

async function deploymentAt(stateRoot: string) {
  return DeploymentStateSchema.parse(
    await readProtectedJson(resolve(stateRoot, "deployment.json")),
  );
}

async function bridgeAt(stateRoot: string, installationId: string) {
  return BridgeStateSchema.parse(
    await readProtectedJson(
      resolve(stateRoot, "installations", installationId, "bridge-state.json"),
    ),
  );
}

function deploymentEnvironment(
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

async function resolveLocalLifecycleDockerEnvironment(
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  const endpoint = await assertLocalDockerContext({
    dockerExecutable: "/usr/bin/docker",
    environment,
    signal,
  });
  return pinLocalDockerEndpoint(environment, endpoint);
}

async function observeOwnedComposeService(
  deployment: z.infer<typeof DeploymentStateSchema>,
  service: "skillwire" | "postgres",
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<boolean> {
  return new DeploymentAdapter({
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
  }).observeOwnedService(service, signal);
}

async function verifyCredentialAuthentication(
  socketPath: string,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "skillwire-credential-rotation", version: "1" },
    },
  });
  await new Promise<void>((done, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: "/mcp",
        method: "POST",
        headers: {
          host: "localhost",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(body),
        },
        signal,
        timeout: 5_000,
      },
      (response) => {
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 64 * 1024) request.destroy();
        });
        response.once("end", () => {
          if (response.statusCode !== undefined && response.statusCode < 400)
            done();
          else
            reject(new Error("Replacement client authentication was rejected"));
        });
      },
    );
    request.once("timeout", () =>
      request.destroy(new Error("Credential verification timed out")),
    );
    request.once("error", () => {
      reject(
        new Error("Replacement client authentication could not be verified"),
      );
    });
    request.end(body);
  });
}

async function acquireOperation(options: {
  readonly roots: LifecycleRoots;
  readonly installationId: string;
  readonly command: string;
}): Promise<{
  readonly lock: InstallationLock;
  readonly journal: OperationJournal;
}> {
  const identity = await currentProcessIdentity();
  const lock = await InstallationLock.acquire(
    resolve(options.roots.runtimeRoot, "locks"),
    "installation",
    identity,
  );
  try {
    const journal = await OperationJournal.create(
      resolve(options.roots.stateRoot, "operations"),
      randomUUID(),
      options.command,
    );
    return { lock, journal };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

async function journalsRequiringRecovery(
  stateRoot: string,
): Promise<readonly OperationJournal[]> {
  const root = resolve(stateRoot, "operations");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
  const journals: OperationJournal[] = [];
  for (const name of names.toSorted()) {
    const match =
      /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/.exec(
        name,
      );
    if (match?.[1] === undefined)
      throw new Error("Unexpected operation journal entry");
    const journal = await OperationJournal.open(root, match[1], "recovery");
    if (journalNeedsRecovery(journal.entries)) journals.push(journal);
  }
  return journals;
}

async function executable(
  client: "codex" | "claude",
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

function result(
  input: Omit<AdminResult, "schemaVersion" | "operationId">,
): AdminResult {
  return AdminResultSchema.parse({
    schemaVersion: "skillwire.admin-result/v1",
    operationId: randomUUID(),
    ...input,
  });
}

function previewResult(
  command: ParsedCommand["route"],
  scope: Record<string, z.infer<ReturnType<typeof z.json>>>,
  summary: string,
): AdminResult {
  const preview = canonicalPreview(command, scope);
  return result({
    command,
    status: "preview",
    exitClass: "success",
    previewHash: preview.hash,
    previewScope: scope,
    changed: false,
    summary,
    components: [],
    findings: [],
    recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
  });
}

async function statusOperation(
  command: ParsedCommand,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<AdminResult> {
  const roots = rootsFor(command, environment);
  const { installation } = await inspectInstalledStatus({
    stateRoot: roots.stateRoot,
    signal,
  });
  const ownership = await ownershipAt(roots.stateRoot);
  const deployment = await deploymentAt(roots.stateRoot);
  const integrations = ClientIntegrationsStateSchema.parse(
    await readProtectedJson(
      resolve(roots.stateRoot, "client-integrations.json"),
    ),
  );
  const components: AdminResult["components"][number][] = [
    {
      component: "installation",
      state: installation.status,
      changed: false,
      owned: true,
      identity: {
        installationId: installation.installationId,
        release: installation.activeReleaseId,
        releaseSequence: installation.highestAcceptedReleaseSequence,
        trustPolicySequence: installation.activeTrustPolicySequence,
      },
    },
    {
      component: "ownership",
      state: "verified",
      changed: false,
      owned: true,
      identity: {
        revision: ownership.recordRevision,
        assetCount: ownership.assets.length,
      },
    },
  ];
  if (installation.status === "data-retained") {
    components.push({
      component: "service",
      state: "data-retained",
      changed: false,
      owned: true,
      identity: {
        postgresVolume: installation.postgresVolume,
        retainedBackups: ownership.assets.filter(
          ({ kind, disposition }) =>
            kind === "backup" && disposition !== "removed",
        ).length,
      },
    });
  } else {
    try {
      const services = await runCommand({
        executable: "/usr/bin/docker",
        args: [
          "compose",
          "--project-name",
          deployment.projectName,
          "--file",
          deployment.composePath,
          "ps",
          "--services",
          "--filter",
          "status=running",
        ],
        environment: deploymentEnvironment(deployment, environment),
        deadlineMilliseconds: 15_000,
        maximumOutputBytes: 16 * 1024,
        signal,
      });
      const running = new Set(
        services.stdout.trim().split("\n").filter(Boolean),
      );
      components.push({
        component: "service",
        state:
          running.has("postgres") && running.has("skillwire")
            ? "running"
            : "degraded",
        changed: false,
        owned: true,
        identity: { composeProject: deployment.projectName },
      });
      const database = new ServiceDatabase({
        dockerExecutable: "/usr/bin/docker",
        projectName: deployment.projectName,
        volumeName: deployment.volumeName,
        composePath: deployment.composePath,
        environment: deploymentEnvironment(deployment, environment),
      });
      const ready = await database.verifySchemaAndReadiness(signal);
      components.push({
        component: "postgres",
        state: "ready",
        changed: false,
        owned: true,
        identity: {
          version: ready.version,
          latestMigration: ready.latestMigration,
        },
      });
    } catch {
      components.push({
        component: "service",
        state: "unavailable",
        changed: false,
        owned: true,
        identity: { composeProject: deployment.projectName },
      });
    }
  }
  for (const client of installation.selectedClients) {
    const integration = integrations.integrations.find(
      (entry) => entry.client === client,
    );
    components.push({
      component: client,
      state: integration?.state ?? "missing-state",
      changed: false,
      owned: integration?.state !== "external-verified",
      identity: {
        profileScope: integration?.profileScope ?? "normal-user",
        credentialReferencePresent:
          integration?.credentialReferenceId !== null &&
          integration?.credentialReferenceId !== undefined,
      },
    });
  }
  const degraded = components.some(({ state }) =>
    ["degraded", "unavailable", "missing-state"].includes(state),
  );
  return result({
    command: "status",
    status: degraded ? "incomplete" : "success",
    exitClass: degraded ? "degraded-or-incomplete" : "success",
    previewHash: null,
    changed: false,
    summary: degraded
      ? "Installed state is intact but a bounded live component is unavailable"
      : `Installation state is ${installation.status}`,
    components,
    findings: [],
    recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
  });
}

async function doctorOperation(
  command: ParsedCommand,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<AdminResult> {
  const roots = rootsFor(command, environment);
  const probes: DiagnosticProbe[] = [];
  let installation: z.infer<typeof InstallationSchema> | undefined;
  let ownership: OwnershipRecord | undefined;
  try {
    installation = (
      await inspectInstalledStatus({ stateRoot: roots.stateRoot, signal })
    ).installation;
  } catch {
    probes.push(
      diagnosticProbe("service-stopped", { installedState: "unavailable" }),
    );
  }
  if (installation !== undefined) {
    try {
      ownership = await ownershipAt(roots.stateRoot);
    } catch {
      probes.push(diagnosticProbe("ownership-drifted", { state: "invalid" }));
    }
    try {
      const set = ServiceSecretSetSchema.parse(
        await readProtectedJson(
          resolve(roots.stateRoot, "service-secret-set.json"),
        ),
      );
      if (set.installationId !== installation.installationId)
        throw new Error("Service-secret installation identity differs");
      for (const reference of set.secrets) {
        const path = resolve(
          roots.dataRoot,
          "installations",
          installation.installationId,
          reference.relativePath,
        );
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stats = await handle.stat();
          if (
            !stats.isFile() ||
            stats.nlink !== 1 ||
            stats.uid !== process.getuid?.() ||
            (stats.mode & 0o777) !== 0o600 ||
            stats.size !== 43
          )
            throw new Error("Unsafe service-secret file");
          const bytes = await handle.readFile();
          const identity = createHash("sha256")
            .update("skillwire-service-secret-identity-v1\0")
            .update(bytes)
            .digest("hex");
          if (identity !== reference.identitySha256)
            throw new Error("Service-secret identity drifted");
        } finally {
          await handle.close();
        }
      }
    } catch {
      probes.push(
        diagnosticProbe("service-secret-unsafe", { state: "invalid" }),
      );
    }
    let deployment: z.infer<typeof DeploymentStateSchema> | undefined;
    try {
      deployment = await deploymentAt(roots.stateRoot);
    } catch {
      probes.push(
        diagnosticProbe("service-stopped", { deploymentState: "invalid" }),
      );
    }
    if (deployment !== undefined) {
      let postgresRunning = false;
      try {
        postgresRunning = await observeOwnedComposeService(
          deployment,
          "postgres",
          environment,
          signal,
        );
      } catch {
        probes.push(
          diagnosticProbe("postgres-unavailable", {
            observedState: "unavailable",
          }),
        );
      }
      try {
        if (
          !(await observeOwnedComposeService(
            deployment,
            "skillwire",
            environment,
            signal,
          ))
        )
          throw new Error("application service is stopped");
      } catch {
        probes.push(
          diagnosticProbe("service-stopped", {
            postgresRunning,
            applicationRunning: false,
          }),
        );
      }
      if (postgresRunning) {
        try {
          const liveMigration = await readLiveMigration(
            deployment,
            environment,
            signal,
          );
          if (liveMigration < 10)
            probes.push(
              diagnosticProbe("migration-pending", { liveMigration }),
            );
          else if (liveMigration > 10)
            probes.push(diagnosticProbe("schema-drifted", { liveMigration }));
          const integrity = await runCommand({
            executable: "/usr/bin/docker",
            args: [
              "compose",
              "--project-name",
              deployment.projectName,
              "--file",
              deployment.composePath,
              "exec",
              "-T",
              "postgres",
              "psql",
              "--username=skillwire",
              "--dbname=skillwire",
              "--tuples-only",
              "--no-align",
              "--set=ON_ERROR_STOP=1",
              "--command",
              "SELECT concat((to_regclass('public.external_skill_revisions') IS NOT NULL)::text,'|',(to_regclass('public.external_advisory_chain_head') IS NOT NULL)::text)",
            ],
            environment: deploymentEnvironment(deployment, environment),
            deadlineMilliseconds: 15_000,
            maximumOutputBytes: 16 * 1024,
            signal,
          });
          const [catalog, advisory] = integrity.stdout.trim().split("|");
          if (catalog !== "true")
            probes.push(diagnosticProbe("catalog-invalid"));
          if (advisory !== "true")
            probes.push(diagnosticProbe("advisory-invalid"));
        } catch {
          probes.push(
            diagnosticProbe("postgres-unavailable", {
              observedState: "query-failed",
            }),
          );
        }
      }
    }
    if (ownership !== undefined) {
      for (const asset of ownership.assets.filter(
        ({ disposition }) => disposition !== "removed",
      )) {
        try {
          if (asset.kind === "release") {
            if (
              (await releaseDirectoryIdentity(asset.locator)) !==
              asset.expectedIdentitySha256
            )
              throw new Error("release identity differs");
          } else if (asset.kind === "trust-policy") {
            const handle = await open(
              resolve(roots.dataRoot, asset.locator),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const stats = await handle.stat();
              if (!stats.isFile() || stats.nlink !== 1)
                throw new Error("trust policy is unsafe");
              if (
                createHash("sha256")
                  .update(await handle.readFile())
                  .digest("hex") !== asset.expectedIdentitySha256
              )
                throw new Error("trust policy identity differs");
            } finally {
              await handle.close();
            }
          } else if (
            asset.kind === "backup" &&
            (await backupDirectoryIdentity(asset.locator)) !==
              asset.expectedIdentitySha256
          )
            throw new Error("backup identity differs");
        } catch {
          probes.push(
            diagnosticProbe(
              asset.kind === "release"
                ? "release-invalid"
                : asset.kind === "trust-policy"
                  ? "trust-policy-invalid"
                  : "backup-invalid",
              { assetId: asset.assetId },
            ),
          );
        }
      }
    }
    try {
      if (installation.selectedClients.length === 0)
        throw new Error("no selected clients");
      const integrations = ClientIntegrationsStateSchema.parse(
        await readProtectedJson(
          resolve(roots.stateRoot, "client-integrations.json"),
        ),
      );
      const credentials = CredentialReferencesStateSchema.parse(
        await readProtectedJson(
          resolve(roots.stateRoot, "credential-references.json"),
        ),
      );
      for (const client of installation.selectedClients) {
        const integration = integrations.integrations.find(
          (entry) => entry.client === client,
        );
        if (integration === undefined) {
          probes.push(diagnosticProbe("client-missing", { client }));
          continue;
        }
        if (
          integration.state !== "external-verified" &&
          !credentials.credentials.some(
            (entry) =>
              entry.client === client &&
              entry.credentialReferenceId ===
                integration.credentialReferenceId &&
              (entry.state === "available" || entry.state === "retained"),
          )
        )
          probes.push(diagnosticProbe("credential-unavailable", { client }));
        if (deployment === undefined) continue;
        try {
          const vendor = await executable(client, environment);
          const adapter =
            client === "codex"
              ? new CodexClientAdapter(vendor, environment, signal)
              : new ClaudeClientAdapter(
                  vendor,
                  environment,
                  undefined,
                  undefined,
                  signal,
                );
          const mcp = await adapter.reconcileMcp(
            resolve(roots.home, ".local/bin/skillwire"),
            installation.installationId,
            integration.mcpIdentitySha256,
          );
          if (mcp.classification === "absent")
            probes.push(diagnosticProbe("mcp-absent", { client }));
          else if (mcp.classification === "ambiguous")
            probes.push(diagnosticProbe("mcp-duplicate", { client }));
          else if (
            mcp.classification !== "owned-equivalent" &&
            mcp.classification !== "external-equivalent"
          )
            probes.push(diagnosticProbe("mcp-conflicting", { client }));
          const plugin = await adapter.reconcilePlugin(
            resolve(
              deployment.releaseRoot,
              client === "codex"
                ? "distribution/codex-release-marketplace"
                : "distribution/claude-marketplace",
            ),
          );
          if (plugin.classification === "absent")
            probes.push(diagnosticProbe("plugin-missing", { client }));
          else if (
            plugin.classification !== "owned-equivalent" &&
            plugin.classification !== "external-equivalent"
          )
            probes.push(diagnosticProbe("plugin-outdated", { client }));
        } catch {
          probes.push(diagnosticProbe("client-missing", { client }));
        }
      }
    } catch {
      if (installation.selectedClients.length > 0)
        probes.push(diagnosticProbe("client-missing", { state: "invalid" }));
    }
    try {
      for (const journal of await journalsRequiringRecovery(roots.stateRoot))
        probes.push(
          diagnosticProbe("journal-recovery-required", {
            operation: journal.operationId,
          }),
        );
    } catch {
      probes.push(
        diagnosticProbe("journal-recovery-required", { state: "invalid" }),
      );
    }
  }
  const findings = await runDoctor(await runDiagnosticProbes(probes, signal));
  return result({
    command: "doctor",
    status: findings.some(({ severity }) => severity === "recovery-required")
      ? "recovery-required"
      : findings.length === 0
        ? "success"
        : "incomplete",
    exitClass: findings.some(({ severity }) => severity === "recovery-required")
      ? "rollback-required"
      : findings.length === 0
        ? "success"
        : "degraded-or-incomplete",
    previewHash: null,
    changed: false,
    summary:
      findings.length === 0
        ? "All bounded installed-state diagnostics passed"
        : "Doctor found lifecycle conditions requiring attention",
    components: [],
    findings: findings.map(({ evidence: _evidence, ...finding }) => finding),
    recovery: {
      rollbackBoundary: findings.some(
        ({ severity }) => severity === "recovery-required",
      )
        ? "application-config"
        : "none",
      backupId: null,
      instructions: [],
    },
  });
}

async function repairOperation(
  command: ParsedCommand,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<AdminResult> {
  const roots = rootsFor(command, environment);
  const installation = InstallationSchema.parse(
    await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
  );
  if (installation.status === "data-retained")
    throw new Error(
      "Repair cannot reactivate a default-uninstalled service; run setup",
    );
  const deployment = await deploymentAt(roots.stateRoot);
  const ownership = await ownershipAt(roots.stateRoot);
  const selectedAssets = ownership.assets.filter(
    (asset) =>
      command.component === undefined || asset.assetId === command.component,
  );
  if (command.component !== undefined && selectedAssets.length !== 1)
    throw new Error("Repair component is not an exact owned asset");
  const observeAsset = async (asset: OwnedAsset): Promise<RepairAsset> => {
    const base = {
      assetId: asset.assetId,
      kind: asset.kind,
      client: asset.client,
      locator: asset.locator,
      expectedIdentitySha256: asset.expectedIdentitySha256,
    };
    if (asset.disposition === "drifted")
      return { ...base, observation: "drifted", ownershipProven: false };
    if (asset.disposition === "ambiguous")
      return { ...base, observation: "ambiguous" };
    if (asset.kind === "credential" || asset.kind === "service-secret")
      return {
        ...base,
        observation: asset.disposition === "removed" ? "missing" : "matching",
      };
    if (asset.kind === "compose-project" || asset.kind === "container") {
      try {
        const service =
          asset.kind === "container"
            ? asset.locator.split(":").at(-1)
            : undefined;
        if (
          service !== undefined &&
          service !== "skillwire" &&
          service !== "postgres"
        )
          throw new Error("Owned Compose service locator is invalid");
        const matching =
          asset.kind === "compose-project"
            ? (await observeOwnedComposeService(
                deployment,
                "postgres",
                environment,
                signal,
              )) &&
              (await observeOwnedComposeService(
                deployment,
                "skillwire",
                environment,
                signal,
              ))
            : service !== undefined &&
              (await observeOwnedComposeService(
                deployment,
                service,
                environment,
                signal,
              ));
        return {
          ...base,
          observation: matching ? "matching" : "missing",
          ownershipProven: true,
        };
      } catch {
        return { ...base, observation: "ambiguous", ownershipProven: false };
      }
    }
    if (
      asset.client !== null &&
      (asset.kind === "mcp-entry" ||
        asset.kind === "plugin" ||
        asset.kind === "marketplace")
    ) {
      try {
        const vendor = await executable(asset.client, environment);
        const adapter =
          asset.client === "codex"
            ? new CodexClientAdapter(vendor, environment, signal)
            : new ClaudeClientAdapter(
                vendor,
                environment,
                undefined,
                undefined,
                signal,
              );
        const state =
          asset.kind === "mcp-entry"
            ? await adapter.reconcileMcp(
                resolve(roots.home, ".local/bin/skillwire"),
                installation.installationId,
                asset.expectedIdentitySha256,
              )
            : await adapter.reconcilePlugin(
                resolve(
                  deployment.releaseRoot,
                  asset.client === "codex"
                    ? "distribution/codex-release-marketplace"
                    : "distribution/claude-marketplace",
                ),
              );
        const matching =
          state.classification === "owned-equivalent" ||
          ((asset.kind === "plugin" || asset.kind === "marketplace") &&
            state.classification === "external-equivalent");
        return {
          ...base,
          observation: matching
            ? "matching"
            : state.classification === "absent"
              ? "missing"
              : "ambiguous",
          ownershipProven: matching || state.classification === "absent",
        };
      } catch {
        return { ...base, observation: "missing", ownershipProven: true };
      }
    }
    return {
      ...base,
      observation: asset.disposition === "removed" ? "ambiguous" : "matching",
    };
  };
  const assets: RepairAsset[] = [];
  for (const asset of selectedAssets) assets.push(await observeAsset(asset));
  const plan = planRepair({ installationId: ownership.installationId, assets });
  const interrupted = await journalsRequiringRecovery(roots.stateRoot);
  const scope = {
    installationId: plan.installationId,
    ownershipRevision: ownership.recordRevision,
    actions: plan.actions.map(
      ({ assetId, kind, client, locator, expectedIdentitySha256 }) => ({
        assetId,
        kind,
        client,
        locator,
        expectedIdentitySha256,
      }),
    ),
    blocked: plan.blocked.map(({ code, assetId }) => ({ code, assetId })),
    interruptedOperations: interrupted.map(({ operationId }) => operationId),
  };
  const preview = canonicalPreview("repair", scope);
  if (command.previewOnly)
    return previewResult("repair", scope, "Ownership-bound repair preview");
  confirmPreview(preview, command.confirmPreview);
  const { lock, journal } = await acquireOperation({
    roots,
    installationId: installation.installationId,
    command: "repair",
  });
  await journal.intent("repair", { previewHash: preview.hash });
  let nextOwnership = ownership;
  let serviceRepaired = false;
  try {
    for (const pending of interrupted) {
      const current = await OperationJournal.open(
        resolve(roots.stateRoot, "operations"),
        pending.operationId,
        "recovery",
      );
      if (!journalNeedsRecovery(current.entries)) continue;
      const recovered = await recoverOperation({
        journal: current,
        signal,
        observe: () => Promise.resolve("ambiguous"),
        compensate: () =>
          Promise.reject(
            new Error(
              "Recovery refused compensation without an exact current identity",
            ),
          ),
      });
      if (recovered.disposition === "recovery-required") {
        await journal.cancel({ status: "failed" });
        return result({
          command: "repair",
          status: "recovery-required",
          exitClass: "rollback-required",
          previewHash: preview.hash,
          previewScope: scope,
          changed: false,
          summary:
            "Repair stopped at an ambiguous interrupted-operation boundary",
          components: [],
          findings: [
            {
              code: "JOURNAL_RECOVERY_REQUIRED",
              severity: "recovery-required",
              component: "journal",
              summary: `Operation ${pending.operationId} has an unproven effect`,
              nextAction:
                "Inspect the named owned effect and resolve its current identity before retrying repair",
            },
          ],
          recovery: {
            rollbackBoundary: "application-config",
            backupId: null,
            instructions: [],
          },
        });
      }
    }
    const repaired = await runRepair({
      plan,
      confirmation: plan.previewHash,
      signal,
      observe: async (candidate) => {
        const currentOwnership = await ownershipAt(roots.stateRoot);
        if (currentOwnership.recordSha256 !== ownership.recordSha256)
          throw new Error("Repair ownership changed after preview");
        const currentAsset = currentOwnership.assets.find(
          ({ assetId }) => assetId === candidate.assetId,
        );
        if (currentAsset === undefined)
          throw new Error("Repair asset disappeared after preview");
        const observed = await observeAsset(currentAsset);
        return {
          observation: observed.observation,
          identitySha256: observed.expectedIdentitySha256,
          ownershipProven: observed.ownershipProven,
        };
      },
      repair: (asset) =>
        journal.runEffect({
          step: `repair-${asset.kind}-${asset.assetId}`,
          intent: { assetId: asset.assetId, kind: asset.kind },
          signal,
          action: async () => {
            if (
              asset.kind === "compose-project" ||
              asset.kind === "container"
            ) {
              if (!serviceRepaired) {
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
                await adapter.probe(signal);
                await adapter.deploy(signal);
                serviceRepaired = true;
              }
            } else if (
              asset.client !== null &&
              (asset.kind === "mcp-entry" ||
                asset.kind === "plugin" ||
                asset.kind === "marketplace")
            ) {
              const vendor = await executable(asset.client, environment);
              const adapter =
                asset.client === "codex"
                  ? new CodexClientAdapter(vendor, environment, signal)
                  : new ClaudeClientAdapter(
                      vendor,
                      environment,
                      undefined,
                      undefined,
                      signal,
                    );
              const marketplacePath = resolve(
                deployment.releaseRoot,
                asset.client === "codex"
                  ? "distribution/codex-release-marketplace"
                  : "distribution/claude-marketplace",
              );
              if (asset.kind === "mcp-entry")
                await adapter.addMcp(
                  resolve(roots.home, ".local/bin/skillwire"),
                  installation.installationId,
                );
              else {
                const pluginState =
                  await adapter.reconcilePlugin(marketplacePath);
                if (pluginState.classification === "absent")
                  await adapter.addPlugin(marketplacePath);
              }
            } else throw new Error("Repair target has no safe exact adapter");
            const original = ownership.assets.find(
              ({ assetId }) => assetId === asset.assetId,
            );
            if (original?.disposition === "removed")
              nextOwnership = reactivateOwnedAsset(
                nextOwnership,
                original.assetId,
                original.expectedIdentitySha256,
              );
          },
          verification: () => ({ assetId: asset.assetId, repaired: true }),
        }),
      rotate: () =>
        Promise.reject(
          new Error("Repair never rotates credentials or service secrets"),
        ),
    });
    if (nextOwnership.recordSha256 !== ownership.recordSha256)
      await journal.runEffect({
        step: "repair-ownership-publication",
        intent: { ownershipRevision: nextOwnership.recordRevision },
        signal,
        action: () =>
          atomicWriteJson(
            resolve(roots.stateRoot, "ownership.json"),
            nextOwnership,
            roots.stateRoot,
          ),
        verification: () => ({
          ownershipRevision: nextOwnership.recordRevision,
        }),
      });
    await journal.commit({ status: "success" });
    const changed = repaired.changedAssets.length > 0;
    return result({
      command: "repair",
      status: plan.blocked.length === 0 ? "success" : "incomplete",
      exitClass:
        plan.blocked.length === 0 ? "success" : "policy-or-ownership-conflict",
      previewHash: preview.hash,
      previewScope: scope,
      changed,
      summary: changed
        ? "Exact ownership-proven components were repaired and reverified"
        : plan.blocked.length === 0
          ? "Owned installation already matches its repairable state"
          : "Unsafe or external repair targets were left unchanged",
      components: repaired.changedAssets.map((assetId) => ({
        component: assetId,
        state: "repaired",
        changed: true,
        owned: true,
        identity: {},
      })),
      findings: plan.blocked.map((block) => ({
        code: block.code,
        severity: "error" as const,
        component: "ownership",
        summary: `Repair skipped owned asset ${block.assetId}`,
        nextAction:
          "Resolve ownership ambiguity without adopting external state",
      })),
      recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
    });
  } catch (error) {
    await journal
      .cancel({
        status: journal.hasUnprovenEffect() ? "recovery-required" : "failed",
      })
      .catch(() => undefined);
    throw journal.failure(error);
  } finally {
    await lock.release();
  }
}

async function rotateClientKeyOperation(
  command: ParsedCommand,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<AdminResult> {
  if (command.client === undefined)
    throw new Error("Client key rotation requires an exact client");
  const roots = rootsFor(command, environment);
  const installation = InstallationSchema.parse(
    await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
  );
  if (installation.status === "data-retained")
    throw new Error("Client key rotation requires a running installation");
  const deployment = await deploymentAt(roots.stateRoot);
  const bridge = await bridgeAt(roots.stateRoot, installation.installationId);
  const current = bridge.clients.find(
    ({ client }) => client === command.client,
  );
  if (current?.keyId === undefined)
    throw new Error(
      "Persisted client key identity is unavailable for safe rotation",
    );
  const ownership = await ownershipAt(roots.stateRoot);
  const credentialAsset = ownership.assets.find(
    (asset) =>
      asset.kind === "credential" &&
      asset.client === command.client &&
      asset.locator === current.credentialReference &&
      (asset.disposition === "present" || asset.disposition === "retained"),
  );
  if (credentialAsset === undefined)
    throw new Error("Matching client credential ownership is unavailable");
  const scope = {
    installationId: installation.installationId,
    client: command.client,
    ownershipRevision: ownership.recordRevision,
    currentCredentialIdentity: createHash("sha256")
      .update(current.credentialReference)
      .digest("hex"),
    effects: [
      "create replacement key",
      "persist and authenticate replacement",
      "switch bridge reference",
      "revoke old key",
      "remove old credential",
    ],
  };
  const preview = canonicalPreview("clients:rotate-key", scope);
  if (command.previewOnly)
    return previewResult(
      "clients:rotate-key",
      scope,
      `Independent ${command.client} client-key rotation preview`,
    );
  confirmPreview(preview, command.confirmPreview);
  const { lock, journal } = await acquireOperation({
    roots,
    installationId: installation.installationId,
    command: "clients-rotate-key",
  });
  await journal.intent("clients-rotate-key", {
    client: command.client,
    previewHash: preview.hash,
  });
  try {
    const currentOwnership = await ownershipAt(roots.stateRoot);
    const currentBridge = await bridgeAt(
      roots.stateRoot,
      installation.installationId,
    );
    const currentEntry = currentBridge.clients.find(
      ({ client }) => client === command.client,
    );
    if (
      currentOwnership.recordSha256 !== ownership.recordSha256 ||
      currentEntry?.keyId !== current.keyId ||
      currentEntry.credentialReference !== current.credentialReference
    )
      throw new Error("Client credential state changed after preview");
    const dockerEnvironment = deploymentEnvironment(deployment, environment);
    const secretService = new SecretToolCredentialStore(
      "/usr/bin/secret-tool",
      environment,
    );
    const fallback = new RestrictiveFileCredentialStore(
      roots.dataRoot,
      roots.dataRoot,
      installation.installationId,
    );
    const usesSecretService =
      current.credentialReference.startsWith("secret-service:");
    const backend: ClientCredentialBackend = {
      store: async (client, token) =>
        usesSecretService
          ? (
              await secretService.store(
                installation.installationId,
                client,
                token,
                signal,
              )
            ).reference
          : fallback.storeReplacement(client, token, randomUUID()),
      lookup: async (client, reference) =>
        reference.startsWith("secret-service:")
          ? secretService.lookup(
              installation.installationId,
              client,
              reference,
              signal,
            )
          : fallback.lookup(reference as RestrictiveFileReference),
      remove: async (client, reference) =>
        reference.startsWith("secret-service:")
          ? secretService.clear(
              installation.installationId,
              client,
              reference,
              AbortSignal.timeout(30_000),
            )
          : fallback.remove(reference as RestrictiveFileReference),
    };
    const service = new ClientCredentialService(
      {
        create: async (client) =>
          createClientKeyInAdminContainer({
            client,
            dockerExecutable: "/usr/bin/docker",
            composePath: deployment.composePath,
            projectName: deployment.projectName,
            accountId: installation.accountId,
            runtimeRoot: roots.runtimeRoot,
            environment: dockerEnvironment,
            signal,
          }),
        revoke: (keyId) =>
          revokeClientKeyInAdminContainer({
            dockerExecutable: "/usr/bin/docker",
            composePath: deployment.composePath,
            projectName: deployment.projectName,
            keyId,
            environment: dockerEnvironment,
            signal: AbortSignal.timeout(30_000),
          }),
      },
      backend,
    );
    const bridgePath = resolve(
      roots.stateRoot,
      "installations",
      installation.installationId,
      "bridge-state.json",
    );
    const replacement = await journal.runEffect({
      step: `client-${command.client}-key-rotation`,
      intent: { client: command.client },
      signal,
      action: () =>
        service.rotate(
          {
            client: command.client ?? "codex",
            keyId: current.keyId ?? "",
            reference: current.credentialReference,
          },
          {
            activate: async (next) => {
              await atomicWriteJson(
                bridgePath,
                {
                  ...currentBridge,
                  clients: currentBridge.clients.map((entry) =>
                    entry.client === command.client
                      ? {
                          ...entry,
                          keyId: next.keyId,
                          credentialReference: next.reference,
                        }
                      : entry,
                  ),
                },
                roots.stateRoot,
              );
            },
            verify: async (next) => {
              const token = await backend.lookup(next.client, next.reference);
              await verifyCredentialAuthentication(
                deployment.socketPath,
                token,
                signal,
              );
            },
            rollback: async () => {
              await atomicWriteJson(bridgePath, currentBridge, roots.stateRoot);
            },
          },
        ),
      verification: (value) => ({
        client: value.client,
        replacementReferenceIdentity: createHash("sha256")
          .update(value.reference)
          .digest("hex"),
      }),
    });
    await journal.runEffect({
      step: `client-${command.client}-rotation-state`,
      intent: { client: command.client },
      signal,
      action: async () => {
        const references = CredentialReferencesStateSchema.parse(
          await readProtectedJson(
            resolve(roots.stateRoot, "credential-references.json"),
          ),
        );
        const integrations = ClientIntegrationsStateSchema.parse(
          await readProtectedJson(
            resolve(roots.stateRoot, "client-integrations.json"),
          ),
        );
        const newReferenceId = randomUUID();
        const keyPublicIdHash = createHash("sha256")
          .update(replacement.keyId)
          .digest("hex");
        const nextReferences = {
          ...references,
          credentials: [
            ...references.credentials.map((entry) =>
              entry.client === command.client && entry.state === "available"
                ? { ...entry, state: "removed" as const }
                : entry,
            ),
            CredentialReferenceSchema.parse({
              schemaVersion: "skillwire.credential-reference/v1",
              credentialReferenceId: newReferenceId,
              installationId: installation.installationId,
              client: command.client,
              backend: replacement.reference.startsWith("secret-service:")
                ? "secret-service"
                : "restrictive-file",
              locator: replacement.reference,
              keyPublicIdHash,
              createdByOperation: journal.operationId,
              state: "available",
              fallbackRiskConfirmed:
                !replacement.reference.startsWith("secret-service:"),
            }),
          ],
        };
        const nextIntegrations = {
          ...integrations,
          integrations: integrations.integrations.map((entry) =>
            entry.client === command.client
              ? ClientIntegrationSchema.parse({
                  ...entry,
                  credentialReferenceId: newReferenceId,
                  keyPublicIdHash,
                })
              : entry,
          ),
        };
        const nextOwnership = replaceOwnedAssetIdentity(
          currentOwnership,
          credentialAsset.assetId,
          {
            locator: replacement.reference,
            expectedIdentitySha256: clientComponentIdentity({
              reference: replacement.reference,
            }),
          },
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "credential-references.json"),
          nextReferences,
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "client-integrations.json"),
          nextIntegrations,
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "ownership.json"),
          nextOwnership,
          roots.stateRoot,
        );
      },
      verification: () => ({
        client: command.client ?? "codex",
        published: true,
      }),
    });
    await journal.commit({ status: "success" });
    return result({
      command: "clients:rotate-key",
      status: "success",
      exitClass: "success",
      previewHash: preview.hash,
      previewScope: scope,
      changed: true,
      summary: `${command.client} client key rotated independently`,
      components: [
        {
          component: command.client,
          state: "credential-rotated",
          changed: true,
          owned: true,
          identity: {
            credentialIdentity: createHash("sha256")
              .update(replacement.reference)
              .digest("hex"),
          },
        },
      ],
      findings: [],
      recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
    });
  } catch (error) {
    await journal
      .cancel({
        status: journal.hasUnprovenEffect() ? "recovery-required" : "failed",
      })
      .catch(() => undefined);
    throw journal.failure(error);
  } finally {
    await lock.release();
  }
}

async function rotateServiceSecretOperation(
  command: ParsedCommand,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<AdminResult> {
  if (command.serviceSecret === undefined)
    throw new Error("Service-secret rotation requires an exact secret kind");
  const kind = command.serviceSecret;
  requireProductionSecretRotationSupport(kind);
  const roots = rootsFor(command, environment);

  function requireProductionSecretRotationSupport(
    requestedKind: typeof kind,
  ): void {
    if (requestedKind !== "application-pepper") return;
    throw new Error(
      "Application-pepper rotation is unsupported until the runtime can authenticate existing client keys through a safe overlap window",
    );
  }
  const installation = InstallationSchema.parse(
    await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
  );
  if (installation.status === "data-retained")
    throw new Error("Service-secret rotation requires a running installation");
  const deployment = await deploymentAt(roots.stateRoot);
  const ownership = await ownershipAt(roots.stateRoot);
  const set = ServiceSecretSetSchema.parse(
    await readProtectedJson(
      resolve(roots.stateRoot, "service-secret-set.json"),
    ),
  );
  const currentReference = set.secrets.find((entry) => entry.kind === kind);
  if (currentReference === undefined)
    throw new Error("Owned service-secret reference is unavailable");
  const currentAsset = ownership.assets.find(
    (asset) =>
      asset.kind === "service-secret" &&
      asset.client === null &&
      asset.locator ===
        `${installation.installationId}/${currentReference.relativePath}` &&
      asset.expectedIdentitySha256 === currentReference.identitySha256 &&
      (asset.disposition === "present" || asset.disposition === "retained"),
  );
  if (currentAsset === undefined)
    throw new Error("Matching service-secret ownership is unavailable");
  const rotationPreview = previewServiceSecretRotation({
    installationId: installation.installationId,
    kind,
    currentIdentitySha256: currentReference.identitySha256,
  });
  const scope = {
    installationId: installation.installationId,
    kind,
    targets: [...rotationPreview.targets],
    currentIdentitySha256: currentReference.identitySha256,
    ownershipRevision: ownership.recordRevision,
    readiness: ["postgresql-17", "migration-010", "application"],
    rollbackBoundary: "application-config",
  };
  const preview = canonicalPreview("maintenance:rotate-service-secret", scope);
  if (command.previewOnly)
    return previewResult(
      "maintenance:rotate-service-secret",
      scope,
      `Explicit ${kind} rotation preview`,
    );
  confirmPreview(preview, command.confirmPreview);
  const { lock, journal } = await acquireOperation({
    roots,
    installationId: installation.installationId,
    command: "rotate-service-secret",
  });
  await journal.intent("rotate-service-secret", {
    kind,
    previewHash: preview.hash,
  });
  const readValue = async (path: string): Promise<string> => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size !== 43
      )
        throw new Error("Service-secret file is unsafe");
      const value = await handle.readFile("ascii");
      if (!/^[A-Za-z0-9_-]{43}$/.test(value))
        throw new Error("Service-secret file format is invalid");
      return value;
    } finally {
      await handle.close();
    }
  };
  const apply = async (
    secretPath: string,
    operationSignal: AbortSignal = signal,
  ): Promise<void> => {
    const databasePasswordFile =
      kind === "database-password"
        ? secretPath
        : deployment.databasePasswordFile;
    const applicationPepperFile =
      kind === "application-pepper"
        ? secretPath
        : deployment.applicationPepperFile;
    const dockerEnvironment = {
      ...deploymentEnvironment(deployment, environment),
      SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE: databasePasswordFile,
      SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE: applicationPepperFile,
    };
    if (kind === "database-password") {
      const value = await readValue(secretPath);
      try {
        await runCommand({
          executable: "/usr/bin/docker",
          args: [
            "compose",
            "--project-name",
            deployment.projectName,
            "--file",
            deployment.composePath,
            "exec",
            "-T",
            "postgres",
            "psql",
            "--username=postgres",
            "--dbname=postgres",
            "--no-psqlrc",
            "--set=ON_ERROR_STOP=1",
            "--file=-",
          ],
          environment: dockerEnvironment,
          stdin: `ALTER ROLE skillwire PASSWORD '${value}';\n`,
          deadlineMilliseconds: 15_000,
          maximumOutputBytes: 16 * 1024,
          signal: operationSignal,
        });
      } catch {
        throw new Error("Database credential rotation command failed");
      }
    }
    const adapter = new DeploymentAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: deployment.composePath,
      projectName: deployment.projectName,
      volumeName: deployment.volumeName,
      skillwireImage: deployment.skillwireImage,
      postgresImage: deployment.postgresImage,
      databasePasswordFile,
      applicationPepperFile,
      runtimeSocketDirectory: deployment.runtimeSocketDirectory,
      socketPath: deployment.socketPath,
      hostEnvironment: environment,
    });
    await adapter.deploy(operationSignal);
  };
  const readiness = async (): Promise<void> => {
    const database = new ServiceDatabase({
      dockerExecutable: "/usr/bin/docker",
      projectName: deployment.projectName,
      volumeName: deployment.volumeName,
      composePath: deployment.composePath,
      environment: deploymentEnvironment(deployment, environment),
    });
    await database.verifySchemaAndReadiness(signal);
  };
  try {
    const lockedOwnership = await ownershipAt(roots.stateRoot);
    const lockedSet = ServiceSecretSetSchema.parse(
      await readProtectedJson(
        resolve(roots.stateRoot, "service-secret-set.json"),
      ),
    );
    if (
      lockedOwnership.recordSha256 !== ownership.recordSha256 ||
      JSON.stringify(lockedSet) !== JSON.stringify(set)
    )
      throw new Error("Service-secret state changed after preview");
    const rotated = await rotateServiceSecret({
      installationRoot: resolve(
        roots.dataRoot,
        "installations",
        installation.installationId,
      ),
      stateRoot: roots.dataRoot,
      kind,
      confirmation: rotationPreview.previewHash,
      preview: rotationPreview,
      signal,
      apply,
      readiness,
      rollback: async (path) => {
        await apply(path, AbortSignal.timeout(60_000));
        await atomicWriteJson(
          resolve(roots.stateRoot, "service-secret-set.json"),
          set,
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "ownership.json"),
          ownership,
          roots.stateRoot,
        );
      },
      journal,
      publish: async ({ identitySha256 }) => {
        let nextOwnership = replaceOwnedAssetIdentity(
          ownership,
          currentAsset.assetId,
          {
            locator: currentAsset.locator,
            expectedIdentitySha256: identitySha256,
          },
        );
        nextOwnership = recordOwnedAsset(
          { record: nextOwnership, externalIntegrations: [] },
          {
            kind: "service-secret",
            client: null,
            locator: `${installation.installationId}/secrets/${kind}.retained-${rotationPreview.operationId}`,
            expectedIdentitySha256: currentReference.identitySha256,
            createdByOperation: journal.operationId,
            retention: "retain-by-default",
            disposition: "present",
          },
        ).record;
        await atomicWriteJson(
          resolve(roots.stateRoot, "service-secret-set.json"),
          {
            ...set,
            state: "available",
            secrets: set.secrets.map((entry) =>
              entry.kind === kind
                ? {
                    ...entry,
                    identitySha256,
                    state: "created" as const,
                  }
                : entry,
            ),
          },
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "ownership.json"),
          nextOwnership,
          roots.stateRoot,
        );
      },
    });
    await journal.commit({ status: "success" });
    return result({
      command: "maintenance:rotate-service-secret",
      status: "success",
      exitClass: "success",
      previewHash: preview.hash,
      previewScope: scope,
      changed: true,
      summary: `${kind} rotated after readiness and durable publication`,
      components: [
        {
          component: "service-secret",
          state: "rotated",
          changed: true,
          owned: true,
          identity: { kind, identitySha256: rotated.identitySha256 },
        },
      ],
      findings: [],
      recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
    });
  } catch (error) {
    await journal
      .cancel({
        status: journal.hasUnprovenEffect() ? "recovery-required" : "failed",
      })
      .catch(() => undefined);
    throw journal.failure(error);
  } finally {
    await lock.release();
  }
}

async function backupOperation(
  command: ParsedCommand,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<AdminResult> {
  const roots = rootsFor(command, environment);
  const installation = InstallationSchema.parse(
    await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
  );
  const deployment = await deploymentAt(roots.stateRoot);
  const secretSet = ServiceSecretSetSchema.parse(
    await readProtectedJson(
      resolve(roots.stateRoot, "service-secret-set.json"),
    ),
  );
  const references = CredentialReferencesStateSchema.parse(
    await readProtectedJson(
      resolve(roots.stateRoot, "credential-references.json"),
    ),
  );
  const ownership = await ownershipAt(roots.stateRoot);
  const backupsRoot = resolve(
    roots.dataRoot,
    "backups",
    installation.installationId,
  );
  const scope = {
    installationId: installation.installationId,
    sourceReleaseId: installation.activeReleaseId,
    archiveDirectory: backupsRoot,
    format: "postgres-custom",
    postgresImage: deployment.postgresImage,
    serviceSecretReferenceCount: secretSet.secrets.length,
    clientCredentialReferenceCount: references.credentials.filter(
      ({ state }) => state === "available" || state === "retained",
    ).length,
    validation: [
      "sha256",
      "isolated-postgresql-17-restore",
      "migration-010",
      "catalog-invariants",
      "readiness",
    ],
  };
  const preview = canonicalPreview("backup", scope);
  if (command.previewOnly)
    return previewResult("backup", scope, "Restore-validated backup preview");
  confirmPreview(preview, command.confirmPreview);
  const { lock, journal } = await acquireOperation({
    roots,
    installationId: installation.installationId,
    command: "backup",
  });
  await journal.intent("backup", { previewHash: preview.hash });
  try {
    const lockedInstallation = InstallationSchema.parse(
      await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
    );
    const lockedOwnership = await ownershipAt(roots.stateRoot);
    if (
      lockedInstallation.updatedAt !== installation.updatedAt ||
      lockedInstallation.installationId !== installation.installationId ||
      lockedOwnership.recordSha256 !== ownership.recordSha256
    )
      throw new Error("Backup prerequisites changed after preview");
    const localDockerEndpoint = await assertLocalDockerContext({
      dockerExecutable: "/usr/bin/docker",
      environment,
      signal,
    });
    const operationEnvironment = pinLocalDockerEndpoint(
      environment,
      localDockerEndpoint,
    );
    const liveSchema = await readLiveMigration(
      deployment,
      operationEnvironment,
      signal,
    );
    const expectedLatestMigration = String(liveSchema).padStart(3, "0");
    const expectedMigrations = await expectedMigrationInventory(
      resolve(deployment.releaseRoot, "migrations"),
      expectedLatestMigration,
    );
    const activeCredentialReferenceCount = references.credentials.filter(
      ({ state }) => state === "available" || state === "retained",
    ).length;
    const sourceEvidence = await readDatabaseEvidence({
      dockerExecutable: "/usr/bin/docker",
      dockerArgs: [
        "compose",
        "--project-name",
        deployment.projectName,
        "--file",
        deployment.composePath,
        "exec",
        "-T",
        "postgres",
      ],
      databaseName: "skillwire",
      databaseUser: "skillwire",
      environment: deploymentEnvironment(deployment, operationEnvironment),
      signal,
      installationAccountId: installation.accountId,
    });
    const expectedState = databaseStateExpectation(sourceEvidence);
    assessRestoredDatabaseEvidence(sourceEvidence, {
      expectedMigrations,
      installationAccountId: installation.accountId,
      expectedActiveApiKeys: activeCredentialReferenceCount,
      expectedDatabase: "skillwire",
      expectedState,
    });
    const adapter = new PostgresBackupAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath: deployment.composePath,
      projectName: deployment.projectName,
      installationId: installation.installationId,
      protectedRoot: roots.dataRoot,
      backupsRoot,
      postgresImage: deployment.postgresImage,
      expectedLatestMigration,
      environment: deploymentEnvironment(deployment, operationEnvironment),
      validateRestoredDatabase: (containerName, validationSignal) =>
        validateRestoredDatabaseContainer({
          dockerExecutable: "/usr/bin/docker",
          containerName,
          environment: deploymentEnvironment(deployment, operationEnvironment),
          signal: validationSignal,
          expectedMigrations,
          installationAccountId: installation.accountId,
          expectedActiveApiKeys: activeCredentialReferenceCount,
          expectedState,
        }),
    });
    const backup = await createValidatedBackup({
      installationId: installation.installationId,
      sourceReleaseId: installation.activeReleaseId,
      serviceSecretReferences: secretSet.secrets,
      clientCredentialReferences: references.credentials
        .filter(({ state }) => state === "available" || state === "retained")
        .map(({ credentialReferenceId }) => credentialReferenceId),
      adapter,
      signal,
      journal,
    });
    await journal.runEffect({
      step: "backup-ownership-publication",
      intent: { backupId: backup.backupId },
      signal,
      action: () =>
        atomicWriteJson(
          resolve(roots.stateRoot, "ownership.json"),
          recordOwnedAsset(
            {
              record: ownership,
              externalIntegrations: [],
            },
            {
              kind: "backup",
              client: null,
              locator: backup.backupRoot,
              expectedIdentitySha256: backup.backupIdentitySha256,
              createdByOperation: journal.operationId,
              retention: "retain-by-default",
              disposition: "present",
            },
          ).record,
          roots.stateRoot,
        ),
      verification: () => ({ backupId: backup.backupId, owned: true }),
    });
    await journal.commit({ status: "success" });
    return result({
      command: "backup",
      status: "success",
      exitClass: "success",
      previewHash: preview.hash,
      previewScope: scope,
      changed: true,
      summary:
        "PostgreSQL backup passed checksum and isolated restore validation",
      components: [
        {
          component: "backup",
          state: "validated",
          changed: true,
          owned: true,
          identity: {
            backupId: backup.backupId,
            archiveSha256: backup.archiveSha256,
          },
        },
      ],
      findings: [],
      recovery: {
        rollbackBoundary: "none",
        backupId: backup.backupId,
        instructions: [],
      },
    });
  } catch (error) {
    await journal
      .cancel({
        status: journal.hasUnprovenEffect() ? "recovery-required" : "failed",
      })
      .catch(() => undefined);
    throw journal.failure(error);
  } finally {
    await lock.release();
  }
}

async function readVerifiedUpgradeManifest(
  path: string,
  expectedSha256: string,
) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 2n ||
      before.size > BigInt(4 * 1024 * 1024)
    )
      throw new Error("Upgrade manifest filesystem identity is unsafe");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256
    )
      throw new Error("Upgrade manifest changed after signed verification");
    return ReleaseManifestSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
  } finally {
    await handle.close();
  }
}

async function verifiedUpgradeCandidate(
  command: ParsedCommand,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  if (command.release === undefined || !isAbsolute(command.release))
    throw new Error("Upgrade requires an absolute signed release archive");
  const archivePath = await realpath(command.release);
  if (!archivePath.endsWith(".tar.zst"))
    throw new Error("Upgrade archive filename is invalid");
  const releaseBase = basename(archivePath).slice(0, -".tar.zst".length);
  const releaseRoot = await realpath(
    resolve(dirname(archivePath), releaseBase),
  );
  const candidateEnvironment = {
    ...environment,
    SKILLWIRE_RELEASE_ROOT: releaseRoot,
  };
  const verified = await previewProductionSetup(
    { clients: "none" },
    candidateEnvironment,
    {},
    signal,
  );
  const expectedArchive = resolve(
    dirname(releaseRoot),
    `${basename(releaseRoot)}.tar.zst`,
  );
  if (archivePath !== expectedArchive)
    throw new Error("Upgrade archive is not the verified payload sibling");
  const manifestPath = resolve(
    dirname(releaseRoot),
    `${basename(releaseRoot)}.release.json`,
  );
  const manifest = await readVerifiedUpgradeManifest(
    manifestPath,
    verified.manifestSha256,
  );
  const skillwireImage = manifest.images.find(
    ({ role }) => role === "skillwire",
  );
  const postgresImage = manifest.images.find(({ role }) => role === "postgres");
  if (skillwireImage === undefined || postgresImage === undefined)
    throw new Error("Upgrade manifest has no complete digest-pinned image set");
  return {
    archivePath,
    releaseRoot,
    manifestPath,
    policyPath: resolve(dirname(releaseRoot), manifest.trustPolicy.path),
    manifest,
    manifestSha256: verified.manifestSha256,
    archiveSha256: verified.archiveSha256,
    skillwireImage: `${skillwireImage.repository}@${skillwireImage.digest}`,
    postgresImage: `${postgresImage.repository}@${postgresImage.digest}`,
    target: {
      releaseId: `${String(manifest.releaseSequence)}-${manifest.architecture}`,
      releaseSequence: manifest.releaseSequence,
      trustPolicySequence: manifest.trustPolicySequence,
      schemaMinimum: manifest.compatibility.schemaMinimum,
      schemaMaximum: manifest.compatibility.schemaMaximum,
      latestMigration: Number(manifest.components.migrations.latest),
      manifestSha256: verified.manifestSha256,
      imageDigest: skillwireImage.digest,
    },
  };
}

async function readLiveMigration(
  deployment: z.infer<typeof DeploymentStateSchema>,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<number> {
  const query = "SELECT max(version) FROM schema_migrations";
  const response = await runCommand({
    executable: "/usr/bin/docker",
    args: [
      "compose",
      "--project-name",
      deployment.projectName,
      "--file",
      deployment.composePath,
      "exec",
      "-T",
      "postgres",
      "psql",
      "--username=skillwire",
      "--dbname=skillwire",
      "--tuples-only",
      "--no-align",
      "--set=ON_ERROR_STOP=1",
      "--command",
      query,
    ],
    environment: deploymentEnvironment(deployment, environment),
    deadlineMilliseconds: 15_000,
    maximumOutputBytes: 16 * 1024,
    signal,
  });
  const value = response.stdout.trim();
  if (!/^\d{3}$/.test(value))
    throw new Error("Live migration identity is invalid");
  return Number(value);
}

function stableLauncher(releaseRoot: string): string {
  const quoted = (value: string): string =>
    `'${value.replaceAll("'", `'"'"'`)}'`;
  return [
    "#!/bin/sh",
    "set -eu",
    `export SKILLWIRE_RELEASE_ROOT=${quoted(releaseRoot)}`,
    `exec ${quoted(resolve(releaseRoot, "runtime/node"))} ${quoted(resolve(releaseRoot, "app/skillwire.mjs"))} "$@"`,
    "",
  ].join("\n");
}

async function restoreStableLauncher(
  home: string,
  releaseRoot: string,
): Promise<void> {
  const launcher = resolve(home, ".local/bin/skillwire");
  const handle = await open(
    launcher,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o777) !== 0o700
    )
      throw new Error("Stable launcher rollback target is unsafe");
  } finally {
    await handle.close();
  }
  const staged = resolve(dirname(launcher), `.skillwire-${randomUUID()}.stage`);
  const stagedHandle = await open(
    staged,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o700,
  );
  try {
    await stagedHandle.writeFile(stableLauncher(releaseRoot), "utf8");
    await stagedHandle.sync();
  } finally {
    await stagedHandle.close();
  }
  await rename(staged, launcher);
  await chmod(launcher, 0o700);
}

async function upgradeOperation(
  command: ParsedCommand,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<AdminResult> {
  const roots = rootsFor(command, environment);
  const installation = InstallationSchema.parse(
    await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
  );
  if (
    installation.status === "data-retained" ||
    installation.status === "purged"
  )
    throw new Error(
      "Upgrade requires a running retained-data-aware installation",
    );
  const deployment = await deploymentAt(roots.stateRoot);
  const ownership = await ownershipAt(roots.stateRoot);
  const secretSet = ServiceSecretSetSchema.parse(
    await readProtectedJson(
      resolve(roots.stateRoot, "service-secret-set.json"),
    ),
  );
  const references = CredentialReferencesStateSchema.parse(
    await readProtectedJson(
      resolve(roots.stateRoot, "credential-references.json"),
    ),
  );
  const localDockerEndpoint = await assertLocalDockerContext({
    dockerExecutable: "/usr/bin/docker",
    environment,
    signal,
  });
  const operationEnvironment = pinLocalDockerEndpoint(
    environment,
    localDockerEndpoint,
  );
  const candidate = await verifiedUpgradeCandidate(
    command,
    operationEnvironment,
    signal,
  );
  const liveSchema = await readLiveMigration(
    deployment,
    operationEnvironment,
    signal,
  );
  const previewInput = {
    installationId: installation.installationId,
    currentReleaseSequence: installation.highestAcceptedReleaseSequence,
    currentTrustPolicySequence: installation.activeTrustPolicySequence,
    liveSchema,
    target: candidate.target,
  };
  const upgradePreview = previewUpgrade(previewInput);
  if (command.previewOnly)
    return previewResult(
      "upgrade",
      previewInput,
      "Signed, restore-validated, forward-only upgrade preview",
    );
  confirmPreview(
    { command: "upgrade", json: "", hash: upgradePreview.previewHash },
    command.confirmPreview,
  );
  const { lock, journal } = await acquireOperation({
    roots,
    installationId: installation.installationId,
    command: "upgrade",
  });
  await journal.intent("upgrade", { previewHash: upgradePreview.previewHash });
  const targetComposePath = resolve(
    candidate.releaseRoot,
    "distribution/self-hosted/compose.yaml",
  );
  const targetDeployment = DeploymentStateSchema.parse({
    ...deployment,
    releaseRoot: resolve(
      roots.dataRoot,
      "releases",
      basename(candidate.releaseRoot),
    ),
    composePath: resolve(
      roots.dataRoot,
      "releases",
      basename(candidate.releaseRoot),
      "distribution/self-hosted/compose.yaml",
    ),
    skillwireImage: candidate.skillwireImage,
    postgresImage: candidate.postgresImage,
  });
  const targetEnvironment = deploymentEnvironment(
    targetDeployment,
    operationEnvironment,
  );
  const privateRuntimeSocketDirectory = resolve(
    roots.runtimeRoot,
    `upgrade-${journal.operationId}`,
  );
  const privateTargetDeployment = DeploymentStateSchema.parse({
    ...targetDeployment,
    runtimeSocketDirectory: privateRuntimeSocketDirectory,
    socketPath: resolve(privateRuntimeSocketDirectory, "mcp.sock"),
  });
  const privateTargetAdapter = new DeploymentAdapter({
    dockerExecutable: "/usr/bin/docker",
    composePath: privateTargetDeployment.composePath,
    projectName: privateTargetDeployment.projectName,
    volumeName: privateTargetDeployment.volumeName,
    skillwireImage: privateTargetDeployment.skillwireImage,
    postgresImage: privateTargetDeployment.postgresImage,
    databasePasswordFile: privateTargetDeployment.databasePasswordFile,
    applicationPepperFile: privateTargetDeployment.applicationPepperFile,
    runtimeSocketDirectory: privateTargetDeployment.runtimeSocketDirectory,
    socketPath: privateTargetDeployment.socketPath,
    hostEnvironment: operationEnvironment,
  });
  const publicTargetAdapter = new DeploymentAdapter({
    dockerExecutable: "/usr/bin/docker",
    composePath: targetDeployment.composePath,
    projectName: targetDeployment.projectName,
    volumeName: targetDeployment.volumeName,
    skillwireImage: targetDeployment.skillwireImage,
    postgresImage: targetDeployment.postgresImage,
    databasePasswordFile: targetDeployment.databasePasswordFile,
    applicationPepperFile: targetDeployment.applicationPepperFile,
    runtimeSocketDirectory: targetDeployment.runtimeSocketDirectory,
    socketPath: targetDeployment.socketPath,
    hostEnvironment: operationEnvironment,
  });
  const composeCommand = (
    composePath: string,
    args: readonly string[],
    commandSignal = signal,
  ) =>
    runCommand({
      executable: "/usr/bin/docker",
      args: [
        "compose",
        "--project-name",
        deployment.projectName,
        "--file",
        composePath,
        ...args,
      ],
      environment: targetEnvironment,
      deadlineMilliseconds: 120_000,
      maximumOutputBytes: 128 * 1024,
      signal: commandSignal,
    });
  let backup: Awaited<ReturnType<typeof createValidatedBackup>> | undefined;
  try {
    const lockedInstallation = InstallationSchema.parse(
      await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
    );
    const lockedOwnership = await ownershipAt(roots.stateRoot);
    const lockedDeployment = await deploymentAt(roots.stateRoot);
    const lockedSchema = await readLiveMigration(
      lockedDeployment,
      operationEnvironment,
      signal,
    );
    if (
      lockedInstallation.updatedAt !== installation.updatedAt ||
      lockedOwnership.recordSha256 !== ownership.recordSha256 ||
      JSON.stringify(lockedDeployment) !== JSON.stringify(deployment) ||
      lockedSchema !== liveSchema
    )
      throw new Error("Upgrade prerequisites changed after preview");
    const expectedMigrations = await expectedMigrationInventory(
      resolve(deployment.releaseRoot, "migrations"),
      String(liveSchema).padStart(3, "0"),
    );
    const activeCredentialReferenceCount = references.credentials.filter(
      ({ state }) => state === "available" || state === "retained",
    ).length;
    const sourceEvidence = await readDatabaseEvidence({
      dockerExecutable: "/usr/bin/docker",
      dockerArgs: [
        "compose",
        "--project-name",
        deployment.projectName,
        "--file",
        deployment.composePath,
        "exec",
        "-T",
        "postgres",
      ],
      databaseName: "skillwire",
      databaseUser: "skillwire",
      environment: deploymentEnvironment(deployment, operationEnvironment),
      signal,
      installationAccountId: installation.accountId,
    });
    const expectedState = databaseStateExpectation(sourceEvidence);
    assessRestoredDatabaseEvidence(sourceEvidence, {
      expectedMigrations,
      installationAccountId: installation.accountId,
      expectedActiveApiKeys: activeCredentialReferenceCount,
      expectedDatabase: "skillwire",
      expectedState,
    });
    const expectedTargetMigrations = await expectedMigrationInventory(
      resolve(candidate.releaseRoot, "migrations"),
      String(candidate.target.latestMigration).padStart(3, "0"),
    );
    const upgraded = await runUpgrade({
      preview: upgradePreview,
      confirmation: command.confirmPreview,
      signal,
      journal,
      verifyTarget: async () =>
        (await verifiedUpgradeCandidate(command, operationEnvironment, signal))
          .target,
      createBackup: async () => {
        const backupsRoot = resolve(
          roots.dataRoot,
          "backups",
          installation.installationId,
        );
        const adapter = new PostgresBackupAdapter({
          dockerExecutable: "/usr/bin/docker",
          composePath: deployment.composePath,
          projectName: deployment.projectName,
          installationId: installation.installationId,
          protectedRoot: roots.dataRoot,
          backupsRoot,
          postgresImage: deployment.postgresImage,
          expectedLatestMigration: String(liveSchema).padStart(3, "0"),
          environment: deploymentEnvironment(deployment, operationEnvironment),
          validateRestoredDatabase: (containerName, validationSignal) =>
            validateRestoredDatabaseContainer({
              dockerExecutable: "/usr/bin/docker",
              containerName,
              environment: deploymentEnvironment(
                deployment,
                operationEnvironment,
              ),
              signal: validationSignal,
              expectedMigrations,
              installationAccountId: installation.accountId,
              expectedActiveApiKeys: activeCredentialReferenceCount,
              expectedState,
            }),
        });
        backup = await createValidatedBackup({
          installationId: installation.installationId,
          sourceReleaseId: installation.activeReleaseId,
          serviceSecretReferences: secretSet.secrets,
          clientCredentialReferences: references.credentials
            .filter(
              ({ state }) => state === "available" || state === "retained",
            )
            .map(({ credentialReferenceId }) => credentialReferenceId),
          adapter,
          signal,
        });
        return {
          backupId: backup.backupId,
          validated: backup.status === "validated",
        };
      },
      drainWriters: () =>
        drainWriters(
          {
            stopAdministration: () => Promise.resolve(),
            stopIngestion: () => Promise.resolve(),
            stopApplication: async (writerSignal) => {
              await composeCommand(
                deployment.composePath,
                ["stop", "skillwire"],
                writerSignal,
              );
            },
            verifyNoWriters: async (writerSignal) => {
              const inspected = await composeCommand(
                deployment.composePath,
                [
                  "exec",
                  "-T",
                  "postgres",
                  "psql",
                  "--username=skillwire",
                  "--dbname=skillwire",
                  "--tuples-only",
                  "--no-align",
                  "--command",
                  "SELECT count(*) FROM pg_stat_activity WHERE datname='skillwire' AND pid <> pg_backend_pid()",
                ],
                writerSignal,
              );
              return inspected.stdout.trim() === "0";
            },
            startApplication: () => Promise.resolve(),
            startIngestion: () => Promise.resolve(),
            startAdministration: () => Promise.resolve(),
          },
          signal,
        ),
      installApplication: async () => {
        await installVerifiedRelease({
          archivePath: candidate.archivePath,
          manifest: candidate.manifest,
          dataRoot: roots.dataRoot,
          stateRoot: roots.stateRoot,
          launcherRoot: roots.home,
          launcherPath: resolve(roots.home, ".local/bin/skillwire"),
          installationId: installation.installationId,
          manifestSha256: candidate.manifestSha256,
          trustPolicyPath: candidate.policyPath,
          activate: false,
        });
        await access(targetComposePath, constants.R_OK);
      },
      migrate: async () => {
        await composeCommand(targetDeployment.composePath, [
          "run",
          "--rm",
          "migrate",
        ]);
      },
      verifyLiveSchema: () =>
        readLiveMigration(targetDeployment, operationEnvironment, signal),
      preActivationReadiness: async () => {
        await privateTargetAdapter.probe(signal);
        await mkdir(privateRuntimeSocketDirectory, { mode: 0o700 });
        await privateTargetAdapter.deploy(signal);
        const targetEvidence = await readDatabaseEvidence({
          dockerExecutable: "/usr/bin/docker",
          dockerArgs: [
            "compose",
            "--project-name",
            targetDeployment.projectName,
            "--file",
            targetDeployment.composePath,
            "exec",
            "-T",
            "postgres",
          ],
          databaseName: "skillwire",
          databaseUser: "skillwire",
          environment: targetEnvironment,
          signal,
          installationAccountId: installation.accountId,
        });
        assessRestoredDatabaseEvidence(targetEvidence, {
          expectedMigrations: expectedTargetMigrations,
          installationAccountId: installation.accountId,
          expectedActiveApiKeys: activeCredentialReferenceCount,
          expectedDatabase: "skillwire",
          expectedState,
        });
      },
      verifyClients: async () => {
        for (const client of installation.selectedClients) {
          const vendor = await executable(client, operationEnvironment);
          const adapter =
            client === "codex"
              ? new CodexClientAdapter(vendor, operationEnvironment, signal)
              : new ClaudeClientAdapter(
                  vendor,
                  operationEnvironment,
                  undefined,
                  undefined,
                  signal,
                );
          const mcp = await adapter.reconcileMcp(
            resolve(roots.home, ".local/bin/skillwire"),
            installation.installationId,
          );
          const plugin = await adapter.reconcilePlugin(
            resolve(
              deployment.releaseRoot,
              client === "codex"
                ? "distribution/codex-release-marketplace"
                : "distribution/claude-marketplace",
            ),
          );
          if (
            !["owned-equivalent", "external-equivalent"].includes(
              mcp.classification,
            ) ||
            !["owned-equivalent", "external-equivalent"].includes(
              plugin.classification,
            )
          )
            throw new Error(`${client} integration changed during upgrade`);
        }
      },
      activateApplication: () => publicTargetAdapter.deploy(signal),
      commitSelection: () =>
        atomicWriteJson(
          resolve(roots.stateRoot, "active-release.json"),
          {
            schemaVersion: "skillwire.active-release/v1",
            releaseVersion: candidate.manifest.releaseVersion,
            releaseSequence: candidate.manifest.releaseSequence,
            trustPolicySequence: candidate.manifest.trustPolicySequence,
            architecture: candidate.manifest.architecture,
            manifestSha256: candidate.manifestSha256,
            archiveSha256: candidate.archiveSha256,
            trustPolicyPath: `trust/${candidate.manifest.trustPolicy.path}`,
          },
          roots.stateRoot,
        ),
      rollbackApplication: async () => {
        const recoverySignal = AbortSignal.timeout(60_000);
        await restoreStableLauncher(roots.home, deployment.releaseRoot);
        const prior = new DeploymentAdapter({
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
          hostEnvironment: operationEnvironment,
        });
        await prior.deploy(recoverySignal);
      },
      stopWriters: async () => {
        await composeCommand(
          targetDeployment.composePath,
          ["stop", "skillwire"],
          AbortSignal.timeout(60_000),
        );
      },
    });
    if (backup === undefined)
      throw new Error("Upgrade completed without a restore-validated backup");
    const completedBackup = backup;
    await journal.runEffect({
      step: "upgrade-state-publication",
      intent: { releaseSequence: candidate.manifest.releaseSequence },
      signal,
      action: async () => {
        let nextOwnership = ownership;
        const targetReleaseIdentity = await releaseDirectoryIdentity(
          targetDeployment.releaseRoot,
        );
        const launcherPath = resolve(roots.home, ".local/bin/skillwire");
        const launcherAsset = nextOwnership.assets.find(
          (asset) => asset.kind === "path" && asset.locator === launcherPath,
        );
        if (launcherAsset !== undefined)
          nextOwnership = replaceOwnedAssetIdentity(
            nextOwnership,
            launcherAsset.assetId,
            {
              locator: launcherPath,
              expectedIdentitySha256: await ownedLauncherIdentity(launcherPath),
            },
          );
        for (const asset of [
          {
            kind: "release" as const,
            locator: targetDeployment.releaseRoot,
            identity: targetReleaseIdentity,
          },
          {
            kind: "trust-policy" as const,
            locator: `trust/${candidate.manifest.trustPolicy.path}`,
            identity: candidate.manifest.trustPolicy.sha256,
          },
          {
            kind: "backup" as const,
            locator: completedBackup.backupRoot,
            identity: completedBackup.backupIdentitySha256,
          },
        ])
          nextOwnership = recordOwnedAsset(
            { record: nextOwnership, externalIntegrations: [] },
            {
              kind: asset.kind,
              client: null,
              locator: asset.locator,
              expectedIdentitySha256: asset.identity,
              createdByOperation: journal.operationId,
              retention: "retain-by-default",
              disposition: "present",
            },
          ).record;
        const timestamp = new Date().toISOString();
        await atomicWriteJson(
          resolve(roots.stateRoot, "deployment.json"),
          targetDeployment,
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "ownership.json"),
          nextOwnership,
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "installation.json"),
          InstallationSchema.parse({
            ...installation,
            activeReleaseId: candidate.target.releaseId,
            highestAcceptedReleaseSequence: candidate.target.releaseSequence,
            activeTrustPolicySequence: candidate.target.trustPolicySequence,
            updatedAt: timestamp,
            lastValidatedAt: timestamp,
          }),
          roots.stateRoot,
        );
      },
      verification: () => ({
        releaseSequence: candidate.target.releaseSequence,
      }),
    });
    await journal.commit({ status: "success" });
    return result({
      command: "upgrade",
      status: "success",
      exitClass: "success",
      previewHash: upgradePreview.previewHash,
      previewScope: previewInput,
      changed: true,
      summary:
        "Signed release selected after backup, schema and readiness gates",
      components: [
        {
          component: "release",
          state: "active",
          changed: true,
          owned: true,
          identity: {
            releaseId: upgraded.releaseId,
            releaseSequence: candidate.target.releaseSequence,
          },
        },
      ],
      findings: [],
      recovery: {
        rollbackBoundary: "none",
        backupId: upgraded.backupId,
        instructions: [],
      },
    });
  } catch (error) {
    const recovery =
      error instanceof UpgradeRecoveryError
        ? upgradeRecoveryGuidance(error)
        : undefined;
    if (recovery !== undefined && backup !== undefined) {
      let retainedOwnership = ownership;
      const retainedReleaseIdentity = await releaseDirectoryIdentity(
        targetDeployment.releaseRoot,
      ).catch(() => undefined);
      const retainedCandidates = [
        {
          kind: "backup" as const,
          locator: backup.backupRoot,
          identity: backup.backupIdentitySha256,
          exists: true,
        },
        {
          kind: "release" as const,
          locator: targetDeployment.releaseRoot,
          identity: retainedReleaseIdentity ?? candidate.archiveSha256,
          exists: retainedReleaseIdentity !== undefined,
        },
        {
          kind: "trust-policy" as const,
          locator: `trust/${candidate.manifest.trustPolicy.path}`,
          identity: candidate.manifest.trustPolicy.sha256,
          exists: await access(
            resolve(
              roots.dataRoot,
              "trust",
              candidate.manifest.trustPolicy.path,
            ),
            constants.R_OK,
          )
            .then(() => true)
            .catch(() => false),
        },
      ];
      for (const retained of retainedCandidates) {
        if (
          retained.exists &&
          !retainedOwnership.assets.some(
            ({ kind, locator, expectedIdentitySha256, disposition }) =>
              kind === retained.kind &&
              locator === retained.locator &&
              expectedIdentitySha256 === retained.identity &&
              disposition !== "removed",
          )
        )
          retainedOwnership = recordOwnedAsset(
            { record: retainedOwnership, externalIntegrations: [] },
            {
              kind: retained.kind,
              client: null,
              locator: retained.locator,
              expectedIdentitySha256: retained.identity,
              createdByOperation: journal.operationId,
              retention: "retain-by-default",
              disposition: "present",
            },
          ).record;
      }
      if (retainedOwnership.recordSha256 !== ownership.recordSha256)
        await journal
          .runEffect({
            step: "upgrade-retained-recovery-assets",
            intent: { backupId: backup.backupId },
            signal: new AbortController().signal,
            action: () =>
              atomicWriteJson(
                resolve(roots.stateRoot, "ownership.json"),
                retainedOwnership,
                roots.stateRoot,
              ),
            verification: () => ({
              backupId: backup?.backupId ?? "unavailable",
            }),
          })
          .catch(() => undefined);
    }
    const restoreRequired =
      recovery?.rollbackBoundary === "database-restore-required";
    const targetActivationRequired =
      error instanceof UpgradeRecoveryError &&
      error.dataLossBoundary ===
        "Retry target activation; do not restore the pre-upgrade backup";
    const recoveryRequired = upgradeFailureRequiresRecovery(
      restoreRequired || targetActivationRequired,
      journal.hasUnprovenEffect(),
    );
    await journal
      .cancel({
        status: recoveryRequired ? "recovery-required" : "failed",
      })
      .catch(() => undefined);
    if (recovery === undefined || !(error instanceof UpgradeRecoveryError))
      throw journal.failure(error);
    return result({
      command: "upgrade",
      status:
        restoreRequired || targetActivationRequired
          ? "recovery-required"
          : "failure",
      exitClass:
        restoreRequired || targetActivationRequired
          ? "rollback-required"
          : "service-failure",
      previewHash: upgradePreview.previewHash,
      previewScope: previewInput,
      changed: true,
      summary: error.message,
      components: [],
      findings: [
        {
          code:
            restoreRequired || targetActivationRequired
              ? "UPGRADE_RECOVERY_REQUIRED"
              : "UPGRADE_AUTOMATIC_ROLLBACK_COMPLETED",
          severity:
            restoreRequired || targetActivationRequired
              ? "recovery-required"
              : "error",
          component: "upgrade",
          summary: error.message,
          nextAction: recovery.instructions.join("; "),
        },
      ],
      recovery: { ...recovery, instructions: [...recovery.instructions] },
    });
  } finally {
    try {
      const privateRuntime = await lstat(privateRuntimeSocketDirectory).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        },
      );
      if (privateRuntime !== undefined) {
        if (
          !privateRuntime.isDirectory() ||
          privateRuntime.isSymbolicLink() ||
          privateRuntime.uid !== process.getuid?.() ||
          (privateRuntime.mode & 0o777) !== 0o700
        )
          // The exact private directory cannot be ignored or removed after
          // ownership drift; surfacing this intentionally overrides success.
          // eslint-disable-next-line no-unsafe-finally
          throw new Error("Private upgrade runtime directory is unsafe");
        await rm(privateRuntimeSocketDirectory, { recursive: true });
      }
    } finally {
      await lock.release();
    }
  }
}

async function defaultUninstallOperation(
  command: ParsedCommand,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<AdminResult> {
  const roots = rootsFor(command, environment);
  const installation = InstallationSchema.parse(
    await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
  );
  const ownership = await ownershipAt(roots.stateRoot);
  const deployment = await deploymentAt(roots.stateRoot);
  const uninstallPreview = previewDefaultUninstall(ownership);
  const scope = {
    installationId: uninstallPreview.installationId,
    ownershipRevision: uninstallPreview.ownershipRevision,
    remove: uninstallPreview.remove.map(
      ({ assetId, kind, client, locator, expectedIdentitySha256 }) => ({
        assetId,
        kind,
        client,
        locator,
        expectedIdentitySha256,
      }),
    ),
    retain: uninstallPreview.retain.map(
      ({ assetId, kind, client, locator }) => ({
        assetId,
        kind,
        client,
        locator,
      }),
    ),
  };
  const preview = canonicalPreview("uninstall", scope);
  if (command.previewOnly)
    return previewResult(
      "uninstall",
      scope,
      "Owned client/runtime removal with retained recovery data",
    );
  confirmPreview(preview, command.confirmPreview);
  if (preview.hash !== uninstallPreview.previewHash)
    throw new Error("Default-uninstall preview canonicalization changed");
  if (installation.status === "data-retained")
    return result({
      command: "uninstall",
      status: "success",
      exitClass: "success",
      previewHash: preview.hash,
      previewScope: scope,
      changed: false,
      summary:
        "Installation data is already retained and runtime state is removed",
      components: [],
      findings: [],
      recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
    });
  const { lock, journal } = await acquireOperation({
    roots,
    installationId: installation.installationId,
    command: "uninstall",
  });
  await journal.intent("uninstall", { previewHash: preview.hash });
  const adapters = new Map<
    "codex" | "claude",
    CodexClientAdapter | ClaudeClientAdapter
  >();
  const adapterFor = async (client: "codex" | "claude") => {
    const existing = adapters.get(client);
    if (existing !== undefined) return existing;
    const vendor = await executable(client, environment);
    const adapter =
      client === "codex"
        ? new CodexClientAdapter(vendor, environment, signal)
        : new ClaudeClientAdapter(
            vendor,
            environment,
            undefined,
            undefined,
            signal,
          );
    adapters.set(client, adapter);
    return adapter;
  };
  const marketplace = (client: "codex" | "claude") =>
    resolve(
      deployment.releaseRoot,
      client === "codex"
        ? "distribution/codex-release-marketplace"
        : "distribution/claude-marketplace",
    );
  const removedPlugin = new Set<"codex" | "claude">();
  const observeIdentity = async (asset: OwnedAsset): Promise<string> => {
    if (asset.client !== null) {
      const adapter = await adapterFor(asset.client);
      if (asset.kind === "mcp-entry") {
        const state = await adapter.reconcileMcp(
          resolve(roots.home, ".local/bin/skillwire"),
          installation.installationId,
          asset.expectedIdentitySha256,
        );
        if (state.classification !== "owned-equivalent")
          throw new Error("Client MCP ownership is ambiguous or drifted");
        return asset.expectedIdentitySha256;
      }
      if (asset.kind === "plugin" || asset.kind === "marketplace") {
        const state = await adapter.reconcilePlugin(marketplace(asset.client));
        if (state.classification !== "external-equivalent")
          throw new Error("Client plugin ownership is ambiguous or drifted");
        return asset.expectedIdentitySha256;
      }
    }
    if (asset.kind === "compose-project") {
      if (asset.locator !== deployment.projectName)
        throw new Error("Compose project ownership changed");
      if (
        !(await observeOwnedComposeService(
          deployment,
          "postgres",
          environment,
          signal,
        )) ||
        !(await observeOwnedComposeService(
          deployment,
          "skillwire",
          environment,
          signal,
        ))
      )
        throw new Error("Owned Compose project is incomplete or missing");
      return clientComponentIdentity({ projectName: deployment.projectName });
    }
    if (asset.kind === "container") {
      const [, service] = asset.locator.split(":");
      if (service !== "skillwire" && service !== "postgres")
        throw new Error("Container ownership changed");
      if (
        !(await observeOwnedComposeService(
          deployment,
          service,
          environment,
          signal,
        ))
      )
        throw new Error("Owned container is missing");
      return clientComponentIdentity({
        projectName: deployment.projectName,
        service,
      });
    }
    return asset.expectedIdentitySha256;
  };
  const removeAsset = async (asset: OwnedAsset): Promise<void> => {
    if (
      asset.client !== null &&
      (asset.kind === "plugin" || asset.kind === "marketplace") &&
      removedPlugin.has(asset.client)
    )
      return;
    await observeIdentity(asset);
    if (asset.client === null) return;
    const adapter = await adapterFor(asset.client);
    if (asset.kind === "mcp-entry") await adapter.removeMcp();
    if (
      (asset.kind === "plugin" || asset.kind === "marketplace") &&
      !removedPlugin.has(asset.client)
    ) {
      if (asset.client === "codex")
        await (adapter as CodexClientAdapter).removePlugin(
          marketplace(asset.client),
        );
      else await (adapter as ClaudeClientAdapter).removePlugin();
      removedPlugin.add(asset.client);
    }
  };
  try {
    const lockedInstallation = InstallationSchema.parse(
      await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
    );
    const lockedOwnership = await ownershipAt(roots.stateRoot);
    if (
      lockedInstallation.updatedAt !== installation.updatedAt ||
      lockedOwnership.recordSha256 !== ownership.recordSha256
    )
      throw new Error("Uninstall prerequisites changed after preview");
    const uninstalled = await runDefaultUninstall({
      ownership,
      preview: uninstallPreview,
      confirmation: uninstallPreview.previewHash,
      signal,
      observeIdentity,
      removeAsset,
      journal,
      stopOwnedService: async () => {
        await runCommand({
          executable: "/usr/bin/docker",
          args: [
            "compose",
            "--project-name",
            deployment.projectName,
            "--file",
            deployment.composePath,
            "down",
            "--remove-orphans",
          ],
          environment: deploymentEnvironment(deployment, environment),
          deadlineMilliseconds: 60_000,
          maximumOutputBytes: 64 * 1024,
          signal,
        });
      },
      publishRetained: async (nextOwnership) => {
        await atomicWriteJson(
          resolve(roots.stateRoot, "ownership.json"),
          nextOwnership,
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "installation.json"),
          transitionInstallation(installation, "data-retained"),
          roots.stateRoot,
        );
      },
    });
    await journal.commit({ status: "success" });
    return result({
      command: "uninstall",
      status: "success",
      exitClass: "success",
      previewHash: preview.hash,
      previewScope: scope,
      changed: uninstalled.removed.length > 0,
      summary:
        "Owned clients and runtime were removed; recovery data is retained",
      components: [
        {
          component: "service",
          state: "data-retained",
          changed: true,
          owned: true,
          identity: {
            installationId: installation.installationId,
            retainedAssets: uninstalled.retained.length,
          },
        },
      ],
      findings: [],
      recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
    });
  } catch (error) {
    await journal
      .cancel({
        status: journal.hasUnprovenEffect() ? "recovery-required" : "failed",
      })
      .catch(() => undefined);
    throw journal.failure(error);
  } finally {
    await lock.release();
  }
}

async function clientUninstallOperation(
  command: ParsedCommand,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<AdminResult> {
  if (command.client === undefined)
    throw new Error("Client uninstall requires an exact client");
  const client = command.client;
  const roots = rootsFor(command, environment);
  const installation = InstallationSchema.parse(
    await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
  );
  const ownership = await ownershipAt(roots.stateRoot);
  const deployment = await deploymentAt(roots.stateRoot);
  const plan = planOwnedAssetDispositions(
    ownership,
    "client-uninstall",
    client,
  );
  const scope = {
    installationId: installation.installationId,
    client,
    ownershipRevision: ownership.recordRevision,
    remove: plan.remove.map(
      ({ assetId, kind, locator, expectedIdentitySha256 }) => ({
        assetId,
        kind,
        locator,
        expectedIdentitySha256,
      }),
    ),
    siblingClient: client === "codex" ? "claude" : "codex",
    sharedData: "retained",
  };
  const preview = canonicalPreview("clients:uninstall", scope);
  if (command.previewOnly)
    return previewResult(
      "clients:uninstall",
      scope,
      `Selective owned-only ${client} uninstall preview`,
    );
  confirmPreview(preview, command.confirmPreview);
  const currentOwnership = await ownershipAt(roots.stateRoot);
  if (currentOwnership.recordSha256 !== ownership.recordSha256)
    throw new Error("Client ownership changed after preview");
  const bridge = await bridgeAt(roots.stateRoot, installation.installationId);
  const bridgeEntry = bridge.clients.find((entry) => entry.client === client);
  const vendor = await executable(client, environment);
  const adapter =
    client === "codex"
      ? new CodexClientAdapter(vendor, environment, signal)
      : new ClaudeClientAdapter(
          vendor,
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
  const observeRemovals = () =>
    Promise.all(
      plan.remove.map(async (asset) => {
        if (asset.kind === "mcp-entry") {
          const state = await adapter.reconcileMcp(
            resolve(roots.home, ".local/bin/skillwire"),
            installation.installationId,
            asset.expectedIdentitySha256,
          );
          return {
            component: "mcp-entry" as const,
            classification: state.classification,
            expectedIdentitySha256: asset.expectedIdentitySha256,
            currentIdentitySha256:
              state.classification === "owned-equivalent"
                ? asset.expectedIdentitySha256
                : (state.observations[0]?.identitySha256 ?? null),
          };
        }
        if (asset.kind === "plugin" || asset.kind === "marketplace") {
          const state = await adapter.reconcilePlugin(marketplacePath);
          const equivalent = state.classification === "external-equivalent";
          return {
            component: asset.kind,
            classification: equivalent
              ? ("owned-equivalent" as const)
              : state.classification,
            expectedIdentitySha256: asset.expectedIdentitySha256,
            currentIdentitySha256: equivalent
              ? asset.expectedIdentitySha256
              : (state.observations[0]?.identitySha256 ?? null),
          };
        }
        if (asset.kind === "credential") {
          const matching =
            bridgeEntry?.credentialReference === asset.locator &&
            bridgeEntry.keyId !== undefined;
          return {
            component: "credential" as const,
            classification: matching
              ? ("owned-equivalent" as const)
              : ("ambiguous" as const),
            expectedIdentitySha256: asset.expectedIdentitySha256,
            currentIdentitySha256: matching
              ? clientComponentIdentity({ reference: asset.locator })
              : null,
          };
        }
        throw new Error("Unexpected client-owned removal asset");
      }),
    );
  const observations = await observeRemovals();
  const secretService = new SecretToolCredentialStore(
    "/usr/bin/secret-tool",
    environment,
  );
  const fallback = new RestrictiveFileCredentialStore(
    roots.dataRoot,
    roots.dataRoot,
    installation.installationId,
  );
  const { lock, journal } = await acquireOperation({
    roots,
    installationId: installation.installationId,
    command: "clients-uninstall",
  });
  await journal.intent("clients-uninstall", {
    client,
    previewHash: preview.hash,
  });
  try {
    const lockedOwnership = await ownershipAt(roots.stateRoot);
    if (lockedOwnership.recordSha256 !== ownership.recordSha256)
      throw new Error("Client ownership changed while acquiring the lock");
    const lockedObservations = await observeRemovals();
    if (JSON.stringify(lockedObservations) !== JSON.stringify(observations))
      throw new Error("Client profile state changed after preview");
    const removed = await journal.runEffect({
      step: `client-${client}-uninstall`,
      intent: { client },
      signal,
      action: () =>
        uninstallClientLifecycle(
          client,
          {
            inspect: () => Promise.resolve(lockedObservations),
            removeMcp: async () => {
              const current = await adapter.reconcileMcp(
                resolve(roots.home, ".local/bin/skillwire"),
                installation.installationId,
                plan.remove.find(({ kind }) => kind === "mcp-entry")
                  ?.expectedIdentitySha256,
              );
              if (current.classification !== "owned-equivalent")
                throw new Error("Client MCP changed before removal");
              await adapter.removeMcp();
            },
            removePlugin: async () => {
              const current = await adapter.reconcilePlugin(marketplacePath);
              if (current.classification !== "external-equivalent")
                throw new Error("Client plugin changed before removal");
              if (client === "codex")
                await (adapter as CodexClientAdapter).removePlugin(
                  marketplacePath,
                );
              else await (adapter as ClaudeClientAdapter).removePlugin();
            },
            removeMarketplace: () => Promise.resolve(),
            revokeCredential: async () => {
              if (bridgeEntry?.keyId === undefined)
                throw new Error("Client key identity is unavailable");
              await revokeClientKeyInAdminContainer({
                dockerExecutable: "/usr/bin/docker",
                composePath: deployment.composePath,
                projectName: deployment.projectName,
                keyId: bridgeEntry.keyId,
                environment: deploymentEnvironment(deployment, environment),
                signal: AbortSignal.timeout(30_000),
              });
              if (bridgeEntry.credentialReference.startsWith("secret-service:"))
                await secretService.clear(
                  installation.installationId,
                  client,
                  bridgeEntry.credentialReference,
                  AbortSignal.timeout(30_000),
                );
              else
                await fallback.remove(
                  bridgeEntry.credentialReference as RestrictiveFileReference,
                );
            },
            verifyAbsent: async (component) => {
              if (component === "credential") return true;
              if (component === "mcp-entry")
                return (
                  (
                    await adapter.reconcileMcp(
                      resolve(roots.home, ".local/bin/skillwire"),
                      installation.installationId,
                    )
                  ).classification === "absent"
                );
              return (
                (await adapter.reconcilePlugin(marketplacePath))
                  .classification === "absent"
              );
            },
          },
          signal,
        ),
      verification: (value) => ({ client, status: value.status }),
    });
    if (removed.status === "recovery-required") {
      await journal.cancel({ status: "recovery-required" });
      return result({
        command: "clients:uninstall",
        status: "recovery-required",
        exitClass: "rollback-required",
        previewHash: preview.hash,
        previewScope: scope,
        changed: removed.removed.length > 0,
        summary: `${client} uninstall stopped at a recoverable boundary`,
        components: [],
        findings: [
          {
            code: "CLIENT_UNINSTALL_RECOVERY_REQUIRED",
            severity: "recovery-required",
            component: client,
            summary: "A client inverse operation could not be proven complete",
            nextAction:
              "Run repair to observe the client-specific journal boundary",
          },
        ],
        recovery: {
          rollbackBoundary: "client-only",
          backupId: null,
          instructions: [],
        },
      });
    }
    await journal.runEffect({
      step: `client-${client}-uninstall-state`,
      intent: { client },
      signal,
      action: async () => {
        let nextOwnership = currentOwnership;
        for (const asset of plan.remove)
          nextOwnership = recordAssetDisposition(
            nextOwnership,
            asset.assetId,
            "removed",
          );
        const references = CredentialReferencesStateSchema.parse(
          await readProtectedJson(
            resolve(roots.stateRoot, "credential-references.json"),
          ),
        );
        const integrations = ClientIntegrationsStateSchema.parse(
          await readProtectedJson(
            resolve(roots.stateRoot, "client-integrations.json"),
          ),
        );
        const nextIntegrations = integrations.integrations.map((entry) => {
          if (entry.client !== client) return entry;
          return transitionClientIntegration(
            entry,
            entry.state === "external-verified"
              ? "retained-external"
              : "removed",
          );
        });
        const selectedClients = installation.selectedClients.filter(
          (selected) => selected !== client,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "ownership.json"),
          nextOwnership,
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "credential-references.json"),
          {
            ...references,
            credentials: references.credentials.map((entry) =>
              entry.client === client
                ? { ...entry, state: "removed" as const }
                : entry,
            ),
          },
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "client-integrations.json"),
          { ...integrations, integrations: nextIntegrations },
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(
            roots.stateRoot,
            "installations",
            installation.installationId,
            "bridge-state.json",
          ),
          {
            ...bridge,
            clients: bridge.clients.filter((entry) => entry.client !== client),
          },
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "installation.json"),
          InstallationSchema.parse({
            ...installation,
            selectedClients,
            clientIntegrationIds: {
              ...installation.clientIntegrationIds,
              [client]: null,
            },
            status: selectedClients.length === 0 ? "service-ready" : "complete",
            updatedAt: new Date().toISOString(),
          }),
          roots.stateRoot,
        );
      },
      verification: () => ({ client, published: true }),
    });
    await journal.commit({ status: "success" });
    return result({
      command: "clients:uninstall",
      status: "success",
      exitClass: "success",
      previewHash: preview.hash,
      previewScope: scope,
      changed: removed.status === "removed",
      summary: `${client} owned integration was removed independently`,
      components: [
        {
          component: client,
          state: removed.status,
          changed: removed.status === "removed",
          owned: true,
          identity: { siblingPreserved: true, sharedDataPreserved: true },
        },
      ],
      findings: [],
      recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
    });
  } catch (error) {
    await journal
      .cancel({
        status: journal.hasUnprovenEffect() ? "recovery-required" : "failed",
      })
      .catch(() => undefined);
    throw journal.failure(error);
  } finally {
    await lock.release();
  }
}

function contained(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function purgeOperation(
  command: ParsedCommand,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<AdminResult> {
  const roots = rootsFor(command, environment);
  const installation = InstallationSchema.parse(
    await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
  );
  if (installation.status !== "data-retained")
    throw new Error(
      "Purge requires default-uninstall-equivalent retained state",
    );
  const ownership = await ownershipAt(roots.stateRoot);
  const purgePreview = previewPurge(ownership);
  const scope = {
    installationId: purgePreview.installationId,
    ownershipRevision: purgePreview.ownershipRevision,
    unrecoverable: purgePreview.unrecoverable.map(
      ({ assetId, kind, client, locator, expectedIdentitySha256 }) => ({
        assetId,
        kind,
        client,
        locator,
        expectedIdentitySha256,
      }),
    ),
  };
  const preview = canonicalPreview("purge", scope);
  if (command.previewOnly)
    return previewResult(
      "purge",
      scope,
      "Permanent removal preview for exact owned retained assets",
    );
  confirmPreview(preview, command.confirmPreview);
  if (preview.hash !== purgePreview.previewHash)
    throw new Error("Purge preview canonicalization changed");
  const deployment = await deploymentAt(roots.stateRoot);
  const bridge = await bridgeAt(roots.stateRoot, installation.installationId);
  const secretService = new SecretToolCredentialStore(
    "/usr/bin/secret-tool",
    environment,
  );
  const fallback = new RestrictiveFileCredentialStore(
    roots.dataRoot,
    roots.dataRoot,
    installation.installationId,
  );
  const filesystemPath = (asset: OwnedAsset): string | undefined => {
    if (asset.kind === "trust-policy")
      return resolve(roots.dataRoot, asset.locator);
    if (asset.kind === "service-secret")
      return resolve(roots.dataRoot, "installations", asset.locator);
    if (
      asset.kind === "path" ||
      asset.kind === "release" ||
      asset.kind === "backup"
    )
      return resolve(asset.locator);
    return undefined;
  };
  const protectedRootFor = (path: string): string => {
    if (contained(roots.dataRoot, path)) return roots.dataRoot;
    if (contained(roots.stateRoot, path)) return roots.stateRoot;
    if (contained(roots.home, path)) return roots.home;
    throw new Error("Purge filesystem target is outside owned roots");
  };
  const allowedFilesFor = (
    asset: OwnedAsset,
    path: string,
  ): string[] | undefined => {
    if (asset.kind !== "path") return undefined;
    const allowed = new Set<string>();
    allowed.add(path);
    if (
      path ===
      resolve(roots.stateRoot, "installations", installation.installationId)
    )
      allowed.add(resolve(path, "bridge-state.json"));
    for (const candidate of ownership.assets) {
      if (
        candidate.kind !== "service-secret" ||
        candidate.disposition === "removed"
      )
        continue;
      const candidatePath = resolve(
        roots.dataRoot,
        "installations",
        candidate.locator,
      );
      if (contained(path, candidatePath)) allowed.add(candidatePath);
    }
    return [...allowed];
  };
  const observeIdentity = async (asset: OwnedAsset): Promise<string> => {
    const path = filesystemPath(asset);
    if (path !== undefined) {
      await validateOwnedFilesystemTree(
        path,
        protectedRootFor(path),
        allowedFilesFor(asset, path),
      );
      if (asset.kind === "trust-policy" || asset.kind === "service-secret") {
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const bytes = await handle.readFile();
          return asset.kind === "service-secret"
            ? createHash("sha256")
                .update("skillwire-service-secret-identity-v1\0")
                .update(bytes)
                .digest("hex")
            : createHash("sha256").update(bytes).digest("hex");
        } finally {
          await handle.close();
        }
      }
      if (asset.kind === "backup") return backupDirectoryIdentity(path);
      if (asset.kind === "path") {
        const launcherIdentity = await ownedLauncherIdentity(path).catch(
          () => undefined,
        );
        if (launcherIdentity !== undefined) return launcherIdentity;
        return clientComponentIdentity({
          [contained(roots.stateRoot, path)
            ? "bridgeStateRoot"
            : "installationRoot"]: path,
        });
      }
      if (asset.kind === "release") return releaseDirectoryIdentity(path);
      return asset.expectedIdentitySha256;
    }
    if (asset.kind === "volume") {
      const inspected = await runCommand({
        executable: "/usr/bin/docker",
        args: [
          "volume",
          "inspect",
          asset.locator,
          "--format",
          '{{.Name}}|{{index .Labels "com.docker.compose.project"}}',
        ],
        environment: deploymentEnvironment(deployment, environment),
        signal,
      });
      if (
        inspected.stdout.trim() !== `${asset.locator}|${deployment.projectName}`
      )
        throw new Error("PostgreSQL volume ownership is ambiguous");
      return clientComponentIdentity({ volumeName: asset.locator });
    }
    if (asset.kind === "credential" && asset.client !== null) {
      const entry = bridge.clients.find(
        ({ client, credentialReference }) =>
          client === asset.client && credentialReference === asset.locator,
      );
      if (entry === undefined)
        throw new Error("Client credential ownership is ambiguous");
      if (asset.locator.startsWith("secret-service:"))
        await secretService.lookup(
          installation.installationId,
          asset.client,
          asset.locator,
          signal,
        );
      else await fallback.lookup(asset.locator as RestrictiveFileReference);
      return clientComponentIdentity({ reference: asset.locator });
    }
    throw new Error("Purge target kind is not safely removable");
  };
  const removeAsset = async (asset: OwnedAsset): Promise<void> => {
    const path = filesystemPath(asset);
    if (path !== undefined) {
      await removeOwnedFilesystemTree(
        path,
        protectedRootFor(path),
        allowedFilesFor(asset, path),
      );
      return;
    }
    if (asset.kind === "volume") {
      await runCommand({
        executable: "/usr/bin/docker",
        args: ["volume", "rm", asset.locator],
        environment: deploymentEnvironment(deployment, environment),
        signal,
      });
      return;
    }
    if (asset.kind === "credential" && asset.client !== null) {
      if (asset.locator.startsWith("secret-service:"))
        await secretService.clear(
          installation.installationId,
          asset.client,
          asset.locator,
          signal,
        );
      else await fallback.remove(asset.locator as RestrictiveFileReference);
      return;
    }
    throw new Error("Purge target kind is not safely removable");
  };
  const { lock, journal } = await acquireOperation({
    roots,
    installationId: installation.installationId,
    command: "purge",
  });
  await journal.intent("purge", { previewHash: preview.hash });
  try {
    const lockedInstallation = InstallationSchema.parse(
      await readProtectedJson(resolve(roots.stateRoot, "installation.json")),
    );
    const lockedOwnership = await ownershipAt(roots.stateRoot);
    if (
      lockedInstallation.updatedAt !== installation.updatedAt ||
      lockedOwnership.recordSha256 !== ownership.recordSha256
    )
      throw new Error("Purge prerequisites changed after preview");
    const purged = await runPurge({
      ownership,
      preview: purgePreview,
      confirmation: purgePreview.previewHash,
      signal,
      observeIdentity,
      removeAsset,
      journal,
    });
    await journal.runEffect({
      step: "purge-state-publication",
      intent: { installationId: installation.installationId },
      signal,
      action: async () => {
        await atomicWriteJson(
          resolve(roots.stateRoot, "ownership.json"),
          purged.ownership,
          roots.stateRoot,
        );
        await atomicWriteJson(
          resolve(roots.stateRoot, "installation.json"),
          transitionInstallation(installation, "purged"),
          roots.stateRoot,
        );
      },
      verification: () => ({ purged: true }),
    });
    await journal.commit({ status: "success" });
    return result({
      command: "purge",
      status: "success",
      exitClass: "success",
      previewHash: preview.hash,
      previewScope: scope,
      changed: purged.removed.length > 0,
      summary: "Exact confirmed owned retained assets were permanently removed",
      components: [
        {
          component: "installation",
          state: "purged",
          changed: true,
          owned: true,
          identity: {
            installationId: installation.installationId,
            unrecoverableAssets: purged.removed.length,
          },
        },
      ],
      findings: [],
      recovery: { rollbackBoundary: "none", backupId: null, instructions: [] },
    });
  } catch (error) {
    await journal
      .cancel({
        status: journal.hasUnprovenEffect() ? "recovery-required" : "failed",
      })
      .catch(() => undefined);
    throw journal.failure(error);
  } finally {
    await lock.release();
  }
}

export function createProductionLifecycleOperations(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    readonly resolveDockerEnvironment?:
      | ((
          environment: NodeJS.ProcessEnv,
          signal: AbortSignal,
        ) => Promise<NodeJS.ProcessEnv>)
      | undefined;
  } = {},
): AdministrativeOperations {
  const resolveDockerEnvironment =
    dependencies.resolveDockerEnvironment ??
    resolveLocalLifecycleDockerEnvironment;
  const withLocalDocker =
    (
      operation: (
        command: ParsedCommand,
        signal: AbortSignal,
        environment: NodeJS.ProcessEnv,
      ) => Promise<AdminResult>,
    ) =>
    async (command: ParsedCommand, signal: AbortSignal) =>
      operation(
        command,
        signal,
        await resolveDockerEnvironment(environment, signal),
      );
  return {
    status: (command, signal) => statusOperation(command, signal, environment),
    doctor: (command, signal) => doctorOperation(command, signal, environment),
    repair: withLocalDocker(repairOperation),
    "clients:rotate-key": withLocalDocker(rotateClientKeyOperation),
    "maintenance:rotate-service-secret": withLocalDocker(
      rotateServiceSecretOperation,
    ),
    backup: withLocalDocker(backupOperation),
    upgrade: withLocalDocker(upgradeOperation),
    "clients:uninstall": withLocalDocker(clientUninstallOperation),
    uninstall: withLocalDocker(defaultUninstallOperation),
    purge: withLocalDocker(purgeOperation),
  };
}
