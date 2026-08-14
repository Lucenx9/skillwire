import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { atomicWriteJson } from "../adapters/filesystem/atomic-state.js";
import {
  installVerifiedRelease,
  releaseDirectoryIdentity,
} from "../adapters/filesystem/release-installer.js";
import { verifySelfHostedRelease } from "../adapters/filesystem/release-verifier.js";
import { DeploymentAdapter } from "../adapters/docker/deployment.js";
import { dockerProcessEnvironment } from "../adapters/docker/environment.js";
import { ServiceDatabase } from "../adapters/postgres/service-database.js";
import {
  ClientKeyHandoffRecoveryError,
  createAccountInAdminContainer,
  createClientKeyInAdminContainer,
  revokeClientKeyInAdminContainer,
} from "../adapters/postgres/bootstrap-admin.js";
import { SecretToolCredentialStore } from "../adapters/credentials/secret-tool.js";
import {
  RestrictiveFileCredentialStore,
  type RestrictiveFileReference,
} from "../adapters/credentials/restrictive-file.js";
import { CodexClientAdapter } from "../adapters/clients/codex.js";
import { ClaudeClientAdapter } from "../adapters/clients/claude.js";
import { clientComponentIdentity } from "../adapters/clients/client-state.js";
import { ensureServiceSecrets } from "../secrets/service-secrets.js";
import type { ClientName } from "../cli/main.js";
import { canonicalPreview } from "../cli/confirmation.js";
import { ClientMutationNotStartedError } from "../domain/client-mutation.js";
import type { ReleaseManifest } from "../domain/release-manifest.js";
import {
  ClientIntegrationSchema,
  CredentialReferenceSchema,
  InstallationSchema,
  ServiceSecretSetSchema,
} from "../domain/installation.js";
import {
  currentProcessIdentity,
  InstallationLock,
  OperationJournal,
} from "../domain/operation-journal.js";
import {
  createOwnershipLedger,
  recordExternalIntegration,
  recordOwnedAsset,
} from "../domain/ownership.js";
import {
  clientConflictFinding,
  ClientProvisioningRecoveryError,
  installClientLifecycle,
} from "./client-lifecycle.js";
import { verifyClientIntegration } from "./client-verification.js";
import { inspectInstalledStatus } from "./status.js";
import { continueProductionSetup } from "./production-continuation.js";
import type {
  GuidedSetupOptions,
  GuidedSetupResult,
  SetupClientResult,
} from "./setup.js";

const CandidateHeaderSchema = z.looseObject({
  releaseVersion: z.string().min(1).max(64),
  trustPolicySequence: z.number().int().positive(),
  architecture: z.enum(["amd64", "arm64"]),
  signatureBundles: z
    .array(
      z
        .object({
          signerId: z.string().min(1).max(64),
          path: z.string().min(1).max(512),
        })
        .strict(),
    )
    .min(1)
    .max(2),
});

const ActiveReleaseStateSchema = z
  .object({
    schemaVersion: z.literal("skillwire.active-release/v1"),
    releaseVersion: z.string().min(1).max(64),
    releaseSequence: z.number().int().positive(),
    trustPolicySequence: z.number().int().positive(),
    architecture: z.enum(["amd64", "arm64"]),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
    trustPolicyPath: z
      .string()
      .regex(/^trust\/skillwire-trust-policy-v[1-9][0-9]*\.json$/),
  })
  .strict();

const ClientIntegrationsStateSchema = z
  .object({
    schemaVersion: z.literal("skillwire.client-integrations/v1"),
    installationId: z.uuid(),
    integrations: z.array(ClientIntegrationSchema).max(2),
  })
  .strict();

export function unchangedSetupClientResults(
  requested: readonly ClientName[],
  installationId: string,
  state: unknown,
): readonly SetupClientResult[] | undefined {
  const integrations = ClientIntegrationsStateSchema.parse(state);
  if (integrations.installationId !== installationId)
    throw new Error(
      "Repeated setup client state belongs to another installation",
    );
  const results: SetupClientResult[] = [];
  for (const client of requested) {
    const integration = integrations.integrations.find(
      (entry) => entry.client === client,
    );
    if (
      integration === undefined ||
      (integration.state !== "verified" &&
        integration.state !== "external-verified")
    )
      return undefined;
    results.push({
      client,
      status: integration.state,
      compensated: false,
      owned: integration.state !== "external-verified",
    });
  }
  return results;
}

export async function ownedLauncherIdentity(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o777) !== 0o700 ||
      stats.size < 1 ||
      stats.size > 64 * 1024
    )
      throw new Error("Stable launcher is not a protected owned file");
    return createHash("sha256")
      .update("skillwire-owned-launcher-v1\0")
      .update(await handle.readFile())
      .digest("hex");
  } finally {
    await handle.close();
  }
}

async function readProtectedSetupJson(path: string): Promise<unknown> {
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
      throw new Error("Repeated setup state is unsafe");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

export interface ProductionTrustOverrides {
  readonly pinnedInitialPolicySha256?: string | undefined;
}

export class ProductionSetupMutationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductionSetupMutationError";
  }
}

export type SetupCredentialBackend = "secret-service" | "restrictive-file";

export interface ProductionSetupPreview {
  readonly releaseRoot: string;
  readonly releaseVersion: string;
  readonly releaseSequence: number;
  readonly manifestSha256: string;
  readonly archiveSha256: string;
  readonly trustPolicySequence: number;
  readonly architecture: "amd64" | "arm64";
  readonly clients: GuidedSetupOptions["clients"];
  readonly endpoint: string;
  readonly transport: "unix-domain-socket";
  readonly port: null;
  readonly composeProjectPattern: "skillwire-<installation-id>";
  readonly postgresVolumePattern: "skillwire-<installation-id>_postgres_data";
  readonly serviceSecretRoot: string;
  readonly runtimeSocketRoot: string;
  readonly credentialBackend: SetupCredentialBackend | "not-selected";
  readonly fallbackRiskConfirmedByThisPreview: boolean;
  readonly components: readonly string[];
  readonly volumes: readonly string[];
  readonly retainedOnFailure: readonly string[];
  readonly catalogChoice: "deferred";
}

interface CandidatePaths {
  readonly root: string;
  readonly base: string;
  readonly manifestPath: string;
  readonly archivePath: string;
  readonly bundlePath: string;
  readonly bundlePaths: readonly string[];
  readonly policyPath: string;
  readonly trustedRootPath: string;
  readonly cosignPath: string;
  readonly architecture: "amd64" | "arm64";
  readonly releaseVersion: string;
}

interface SetupRoots {
  readonly home: string;
  readonly dataRoot: string;
  readonly stateRoot: string;
  readonly runtimeRoot: string;
  readonly launcherRoot: string;
  readonly launcherPath: string;
}

function selectedClients(
  selection: GuidedSetupOptions["clients"],
): readonly ClientName[] {
  if (selection === "none") return [];
  if (selection === "codex,claude") return ["codex", "claude"];
  return [selection];
}

function roots(environment: NodeJS.ProcessEnv): SetupRoots {
  const dataHome =
    environment["XDG_DATA_HOME"] ??
    resolve(environment["HOME"] ?? "", ".local/share");
  const stateHome =
    environment["XDG_STATE_HOME"] ??
    resolve(environment["HOME"] ?? "", ".local/state");
  const runtimeHome = environment["XDG_RUNTIME_DIR"];
  const home = environment["HOME"];
  if (
    !isAbsolute(dataHome) ||
    !isAbsolute(stateHome) ||
    runtimeHome === undefined ||
    !isAbsolute(runtimeHome) ||
    home === undefined ||
    !isAbsolute(home)
  ) {
    throw new Error(
      "Absolute HOME and XDG data/state/runtime roots are required for setup",
    );
  }
  return {
    home,
    dataRoot: resolve(dataHome, "skillwire"),
    stateRoot: resolve(stateHome, "skillwire"),
    runtimeRoot: resolve(runtimeHome, "skillwire"),
    launcherRoot: resolve(home),
    launcherPath: resolve(home, ".local/bin/skillwire"),
  };
}

async function candidatePaths(
  environment: NodeJS.ProcessEnv,
): Promise<CandidatePaths> {
  const configuredRoot = environment["SKILLWIRE_RELEASE_ROOT"];
  if (configuredRoot === undefined || !isAbsolute(configuredRoot)) {
    throw new Error("Setup must run through the verified release launcher");
  }
  const root = await realpath(configuredRoot);
  const base = basename(root);
  const match = /^skillwire-(.+)-linux-(amd64|arm64)$/.exec(base);
  if (match === null)
    throw new Error("Verified release directory name is invalid");
  const releaseVersion = match[1];
  const architecture = match[2];
  if (
    releaseVersion === undefined ||
    (architecture !== "amd64" && architecture !== "arm64")
  ) {
    throw new Error("Verified release identity is incomplete");
  }
  const hostArchitecture =
    process.arch === "x64"
      ? "amd64"
      : process.arch === "arm64"
        ? "arm64"
        : undefined;
  if (process.platform !== "linux" || hostArchitecture !== architecture) {
    throw new Error("Release does not match this supported Linux architecture");
  }
  const manifestPath = resolve(dirname(root), `${base}.release.json`);
  const header = CandidateHeaderSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  if (
    header.releaseVersion !== releaseVersion ||
    header.architecture !== architecture
  ) {
    throw new Error("Release directory and manifest identity differ");
  }
  return {
    root,
    base,
    manifestPath,
    archivePath: resolve(dirname(root), `${base}.tar.zst`),
    bundlePath: resolve(dirname(root), header.signatureBundles[0]?.path ?? ""),
    bundlePaths: header.signatureBundles.map(({ path }) =>
      resolve(dirname(root), path),
    ),
    policyPath: resolve(
      dirname(root),
      `skillwire-trust-policy-v${String(header.trustPolicySequence)}.json`,
    ),
    trustedRootPath: resolve(
      root,
      "distribution/self-hosted/trusted-root.v1.json",
    ),
    cosignPath: resolve(root, "tools/cosign"),
    architecture,
    releaseVersion,
  };
}

export async function selectCredentialBackend(
  clients: GuidedSetupOptions["clients"],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<SetupCredentialBackend | "not-selected"> {
  if (clients === "none") return "not-selected";
  const store = new SecretToolCredentialStore(
    "/usr/bin/secret-tool",
    environment,
  );
  return (await store.probe(signal)) === "available"
    ? "secret-service"
    : "restrictive-file";
}

async function activeReleaseState(
  stateRoot: string,
): Promise<z.infer<typeof ActiveReleaseStateSchema> | undefined> {
  let handle;
  try {
    handle = await open(
      resolve(stateRoot, "active-release.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > 16 * 1024
    ) {
      throw new Error("Active release state is unsafe");
    }
    return ActiveReleaseStateSchema.parse(
      JSON.parse(await handle.readFile("utf8")) as unknown,
    );
  } finally {
    await handle.close();
  }
}

async function verifyCandidate(
  candidate: CandidatePaths,
  setupRoots: SetupRoots,
  trustOverrides: ProductionTrustOverrides = {},
  signal?: AbortSignal,
): Promise<{
  readonly manifest: ReleaseManifest;
  readonly releaseVersion: string;
  readonly releaseSequence: number;
  readonly trustPolicySequence: number;
  readonly manifestSha256: string;
  readonly archiveSha256: string;
}> {
  const active = await activeReleaseState(setupRoots.stateRoot);
  const verified = await verifySelfHostedRelease({
    manifestPath: candidate.manifestPath,
    bundlePath: candidate.bundlePath,
    bundlePaths: candidate.bundlePaths,
    archive: candidate.archivePath,
    payload: candidate.root,
    policyPath: candidate.policyPath,
    trustedRootPath: candidate.trustedRootPath,
    cosign: candidate.cosignPath,
    architecture: candidate.architecture,
    signal,
    currentReleaseSequence: active?.releaseSequence ?? 0,
    currentTrustSequence: active?.trustPolicySequence ?? 0,
    ...(active === undefined
      ? {
          pinnedInitialPolicySha256: trustOverrides.pinnedInitialPolicySha256,
        }
      : {
          currentPolicyPath: resolve(
            setupRoots.dataRoot,
            active.trustPolicyPath,
          ),
          currentPolicyRoot: setupRoots.dataRoot,
        }),
  });
  if (
    active?.releaseSequence === verified.releaseSequence &&
    (active.manifestSha256 !== verified.manifestSha256 ||
      active.archiveSha256 !== verified.archiveSha256)
  ) {
    throw new Error("Equal-sequence release equivocation is forbidden");
  }
  return verified;
}

export async function previewProductionSetup(
  options: GuidedSetupOptions,
  environment: NodeJS.ProcessEnv = process.env,
  trustOverrides: ProductionTrustOverrides = {},
  signal?: AbortSignal,
): Promise<ProductionSetupPreview> {
  const candidate = await candidatePaths(environment);
  const setupRoots = roots(environment);
  const verified = await verifyCandidate(
    candidate,
    setupRoots,
    trustOverrides,
    signal,
  );
  const backend = await selectCredentialBackend(
    options.clients,
    environment,
    signal,
  );
  return setupPreviewScope(options, candidate, setupRoots, verified, backend);
}

function setupPreviewScope(
  options: GuidedSetupOptions,
  candidate: CandidatePaths,
  setupRoots: SetupRoots,
  verified: {
    readonly releaseSequence: number;
    readonly manifestSha256: string;
    readonly archiveSha256: string;
    readonly trustPolicySequence: number;
  },
  backend: SetupCredentialBackend | "not-selected",
): ProductionSetupPreview {
  const runtimeSocketRoot = resolve(
    setupRoots.runtimeRoot,
    "s-<installation-id-sha256-prefix>",
  );
  const clients = selectedClients(options.clients);
  return {
    releaseRoot: candidate.root,
    releaseVersion: candidate.releaseVersion,
    releaseSequence: verified.releaseSequence,
    manifestSha256: verified.manifestSha256,
    archiveSha256: verified.archiveSha256,
    trustPolicySequence: verified.trustPolicySequence,
    architecture: candidate.architecture,
    clients: options.clients,
    endpoint: `unix://${runtimeSocketRoot}/mcp.sock`,
    transport: "unix-domain-socket",
    port: null,
    composeProjectPattern: "skillwire-<installation-id>",
    postgresVolumePattern: "skillwire-<installation-id>_postgres_data",
    serviceSecretRoot: resolve(
      setupRoots.dataRoot,
      "installations/<installation-id>/secrets",
    ),
    runtimeSocketRoot,
    credentialBackend: backend,
    fallbackRiskConfirmedByThisPreview: backend === "restrictive-file",
    components: ["service", "postgres", "credential-bridge", ...clients],
    volumes: ["skillwire-<installation-id>_postgres_data"],
    retainedOnFailure: ["verified release", "service data", "service secrets"],
    catalogChoice: "deferred",
  };
}

async function executable(
  name: "codex" | "claude",
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const search = (environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin")
    .split(":")
    .filter((entry) => isAbsolute(entry));
  for (const directory of search) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the bounded, caller-provided normal PATH.
    }
  }
  throw new Error(`Certified ${name} executable is unavailable`);
}

function composeEnvironment(options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly projectName: string;
  readonly volumeName: string;
  readonly skillwireImage: string;
  readonly postgresImage: string;
  readonly databasePasswordFile: string;
  readonly applicationPepperFile: string;
  readonly runtimeSocketDirectory: string;
}): NodeJS.ProcessEnv {
  return dockerProcessEnvironment(options.environment, {
    SKILLWIRE_COMPOSE_PROJECT: options.projectName,
    SKILLWIRE_POSTGRES_VOLUME: options.volumeName,
    SKILLWIRE_IMAGE: options.skillwireImage,
    SKILLWIRE_POSTGRES_IMAGE: options.postgresImage,
    SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE: options.databasePasswordFile,
    SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE: options.applicationPepperFile,
    SKILLWIRE_RUNTIME_SOCKET_DIRECTORY: options.runtimeSocketDirectory,
    SKILLWIRE_RUNTIME_UID: String(process.getuid?.() ?? 10001),
    SKILLWIRE_RUNTIME_GID: String(process.getgid?.() ?? 10001),
  });
}

function image(
  manifest: ReleaseManifest,
  name: "skillwire" | "postgres",
): string {
  const entry = manifest.images.find((candidate) => candidate.role === name);
  if (entry === undefined)
    throw new Error(`Release does not bind the ${name} image`);
  return `${entry.repository}@${entry.digest}`;
}

async function runProductionSetupUnlocked(
  options: GuidedSetupOptions & {
    readonly credentialBackend: SetupCredentialBackend | "not-selected";
    readonly previewHash?: string | undefined;
  },
  signal: AbortSignal,
  journal: OperationJournal,
  environment: NodeJS.ProcessEnv = process.env,
  trustOverrides: ProductionTrustOverrides = {},
): Promise<GuidedSetupResult> {
  if (signal.aborted) throw new Error("Setup cancelled before mutation");
  try {
    const candidate = await candidatePaths(environment);
    const setupRoots = roots(environment);
    await mkdir(setupRoots.dataRoot, { recursive: true, mode: 0o700 });
    await mkdir(setupRoots.stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(setupRoots.runtimeRoot, { recursive: true, mode: 0o700 });
    const verified = await verifyCandidate(
      candidate,
      setupRoots,
      trustOverrides,
      signal,
    );
    const expectedPreview = canonicalPreview(
      "setup",
      setupPreviewScope(
        options,
        candidate,
        setupRoots,
        verified,
        options.credentialBackend,
      ),
    );
    if (
      options.previewHash !== undefined &&
      options.previewHash !== expectedPreview.hash
    ) {
      throw new Error(
        "Preview hash confirmation no longer matches the verified setup candidate",
      );
    }
    const { manifest } = verified;
    const installationId = randomUUID();
    const projectName = `skillwire-${installationId.replaceAll("-", "").slice(0, 16)}`;
    const volumeName = `${projectName}_postgres_data`;
    const runEffect = async <T>(effectOptions: {
      readonly step: string;
      readonly intent: Record<string, string | number | boolean | null>;
      readonly action: () => Promise<T>;
      readonly effectNotStarted?: (error: unknown) => boolean;
      readonly verification: (
        value: T,
      ) => Record<string, string | number | boolean | null>;
    }): Promise<T> => {
      return journal.runEffect({ ...effectOptions, signal });
    };
    const installed = await runEffect({
      step: "verified-release-install",
      intent: {
        installationId,
        manifestSha256: verified.manifestSha256,
      },
      action: () =>
        installVerifiedRelease({
          archivePath: candidate.archivePath,
          manifest,
          dataRoot: setupRoots.dataRoot,
          stateRoot: setupRoots.stateRoot,
          launcherRoot: setupRoots.launcherRoot,
          launcherPath: setupRoots.launcherPath,
          installationId,
          manifestSha256: verified.manifestSha256,
          trustPolicyPath: candidate.policyPath,
        }),
      verification: (value) => ({
        launcherInstalled: value.launcherPath === setupRoots.launcherPath,
      }),
    });
    const installationRoot = resolve(
      setupRoots.dataRoot,
      "installations",
      installationId,
    );
    const secretReferences = await runEffect({
      step: "service-secrets",
      intent: { installationId, componentCount: 2 },
      action: () => ensureServiceSecrets(installationRoot, setupRoots.dataRoot),
      verification: (value) => ({ secretReferenceCount: value.length }),
    });
    const databasePasswordFile = resolve(
      installationRoot,
      "secrets/database-password",
    );
    const applicationPepperFile = resolve(
      installationRoot,
      "secrets/application-pepper",
    );
    const composePath = resolve(
      installed.releaseRoot,
      "distribution/self-hosted/compose.yaml",
    );
    const skillwireImage = image(manifest, "skillwire");
    const postgresImage = image(manifest, "postgres");
    const runtimeSocketDirectory = resolve(
      setupRoots.runtimeRoot,
      `s-${createHash("sha256").update(installationId).digest("hex").slice(0, 24)}`,
    );
    await mkdir(runtimeSocketDirectory, { recursive: true, mode: 0o700 });
    await chmod(runtimeSocketDirectory, 0o700);
    const runtimeDirectoryStats = await lstat(runtimeSocketDirectory);
    if (
      !runtimeDirectoryStats.isDirectory() ||
      runtimeDirectoryStats.isSymbolicLink() ||
      runtimeDirectoryStats.uid !== process.getuid?.() ||
      (runtimeDirectoryStats.mode & 0o777) !== 0o700
    ) {
      throw new Error("Runtime socket directory is unsafe");
    }
    const socketPath = resolve(runtimeSocketDirectory, "mcp.sock");
    if (socketPath.length > 103)
      throw new Error("Runtime socket path exceeds the Linux boundary");
    const dockerEnvironment = composeEnvironment({
      environment,
      projectName,
      volumeName,
      skillwireImage,
      postgresImage,
      databasePasswordFile,
      applicationPepperFile,
      runtimeSocketDirectory,
    });
    const deployment = new DeploymentAdapter({
      dockerExecutable: "/usr/bin/docker",
      composePath,
      projectName,
      volumeName,
      skillwireImage,
      postgresImage,
      databasePasswordFile,
      applicationPepperFile,
      runtimeSocketDirectory,
      socketPath,
      hostEnvironment: environment,
    });
    await runEffect({
      step: "deployment",
      intent: { projectName, volumeName },
      action: async () => {
        await deployment.probe(signal);
        await deployment.deploy(signal);
      },
      verification: () => ({ composeReady: true }),
    });
    const database = new ServiceDatabase({
      dockerExecutable: "/usr/bin/docker",
      projectName,
      volumeName,
      composePath,
      environment: dockerEnvironment,
    });
    await database.verifyVolume(signal);
    await database.verifySchemaAndReadiness(signal);
    const accountId = await runEffect({
      step: "account-create",
      intent: { projectName },
      action: () =>
        createAccountInAdminContainer({
          dockerExecutable: "/usr/bin/docker",
          composePath,
          projectName,
          environment: dockerEnvironment,
          signal,
        }),
      verification: (value) => ({ accountId: value }),
    });
    const bridgeStateRoot = resolve(
      setupRoots.stateRoot,
      "installations",
      installationId,
    );
    await mkdir(bridgeStateRoot, { recursive: true, mode: 0o700 });
    const bridgeClients: {
      client: ClientName;
      credentialReference: string;
      keyId: string;
    }[] = [];
    const persistBridgeState = (): Promise<void> =>
      atomicWriteJson(
        resolve(bridgeStateRoot, "bridge-state.json"),
        {
          schemaVersion: "skillwire.bridge-state/v1",
          installationId,
          transport: "unix-domain-socket",
          endpoint: "http://localhost/mcp",
          socketPath,
          clients: bridgeClients,
        },
        setupRoots.stateRoot,
      );
    await runEffect({
      step: "bridge-state-initial",
      intent: { installationId, clientCount: 0 },
      action: persistBridgeState,
      verification: () => ({ published: true }),
    });

    const clientResults: SetupClientResult[] = [];
    const clientOwnership: {
      readonly client: ClientName;
      readonly result: Awaited<ReturnType<typeof installClientLifecycle>>;
      readonly credentialReference: string | undefined;
      readonly keyId: string | undefined;
      readonly marketplacePath: string;
    }[] = [];
    for (const client of selectedClients(options.clients)) {
      const secretService = new SecretToolCredentialStore(
        "/usr/bin/secret-tool",
        environment,
      );
      const fallback = new RestrictiveFileCredentialStore(
        setupRoots.dataRoot,
        setupRoots.dataRoot,
        installationId,
      );
      let currentReference: string | undefined;
      let currentKeyId: string | undefined;
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
      const recoveryAdapter = () =>
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
      const marketplacePath = resolve(
        installed.releaseRoot,
        client === "codex"
          ? "distribution/codex-release-marketplace"
          : "distribution/claude-marketplace",
      );
      const result = await installClientLifecycle(client, {
        preflight: async () => {
          const [mcpState, pluginState] = await Promise.all([
            adapter.reconcileMcp(installed.launcherPath, installationId),
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
                      {
                        scope: blocked.observations[0].scope,
                        identitySha256: blocked.observations[0].identitySha256,
                      },
                    ),
                  }),
            };
          const mcp =
            mcpState.classification === "absent"
              ? "create"
              : mcpState.classification === "owned-equivalent"
                ? "reuse-owned"
                : "reuse-external";
          const plugin =
            pluginState.classification === "absent"
              ? "create"
              : pluginState.classification === "owned-equivalent"
                ? "reuse-owned"
                : "reuse-external";
          return {
            action:
              mcp === "reuse-external" && plugin === "reuse-external"
                ? "reuse-external"
                : "proceed",
            mcp,
            plugin,
          };
        },
        provisionCredential: async () => {
          const key = await runEffect({
            step: `client-${client}-key`,
            intent: { client, accountId },
            action: () =>
              createClientKeyInAdminContainer({
                client,
                dockerExecutable: "/usr/bin/docker",
                composePath,
                projectName,
                accountId,
                runtimeRoot: setupRoots.runtimeRoot,
                environment: dockerEnvironment,
                signal,
              }).catch((error: unknown) => {
                if (error instanceof ClientKeyHandoffRecoveryError) {
                  throw new ClientProvisioningRecoveryError(error.message);
                }
                throw error;
              }),
            verification: (value) => ({ client, keyId: value.keyId }),
          });
          currentKeyId = key.keyId;
          try {
            return await runEffect({
              step: `client-${client}-credential`,
              intent: { client, backend: options.credentialBackend },
              action: async () => {
                if (options.credentialBackend === "not-selected") {
                  throw new Error(
                    "A selected client requires a credential backend",
                  );
                }
                if (options.credentialBackend === "secret-service") {
                  currentReference = (
                    await secretService.store(
                      installationId,
                      client,
                      key.token,
                      signal,
                    )
                  ).reference;
                  const stored = await secretService.lookup(
                    installationId,
                    client,
                    currentReference,
                    signal,
                  );
                  if (
                    stored.length !== key.token.length ||
                    !timingSafeEqual(
                      Buffer.from(stored),
                      Buffer.from(key.token),
                    )
                  ) {
                    throw new Error(
                      "Secret Service credential readback failed",
                    );
                  }
                } else {
                  currentReference = await fallback.store(
                    client,
                    key.token,
                    true,
                  );
                  const stored = await fallback.lookup(
                    currentReference as RestrictiveFileReference,
                  );
                  if (
                    stored.length !== key.token.length ||
                    !timingSafeEqual(
                      Buffer.from(stored),
                      Buffer.from(key.token),
                    )
                  ) {
                    throw new Error("Restrictive credential readback failed");
                  }
                }
                bridgeClients.push({
                  client,
                  credentialReference: currentReference,
                  keyId: key.keyId,
                });
                await persistBridgeState();
                return { keyId: key.keyId, reference: currentReference };
              },
              verification: (value) => ({
                client,
                credentialReference: value.reference,
              }),
            });
          } catch (error) {
            const index = bridgeClients.findIndex(
              (entry) => entry.client === client,
            );
            if (index >= 0) bridgeClients.splice(index, 1);
            const credentialCleanup = currentReference?.startsWith(
              "secret-service:",
            )
              ? secretService.clear(installationId, client, currentReference)
              : currentReference === undefined
                ? Promise.resolve()
                : fallback.remove(currentReference as RestrictiveFileReference);
            const compensation = await Promise.allSettled([
              persistBridgeState(),
              credentialCleanup,
              revokeClientKeyInAdminContainer({
                dockerExecutable: "/usr/bin/docker",
                composePath,
                projectName,
                keyId: key.keyId,
                environment: dockerEnvironment,
              }),
            ]);
            if (compensation.some(({ status }) => status === "rejected")) {
              throw new ClientProvisioningRecoveryError(
                "Credential provisioning failed and its narrow compensation needs recovery",
              );
            }
            throw error;
          }
        },
        addMcp: () =>
          runEffect({
            step: `client-${client}-mcp-profile`,
            intent: { client, component: "mcp" },
            action: () =>
              adapter.addMcp(installed.launcherPath, installationId),
            effectNotStarted: (error) =>
              error instanceof ClientMutationNotStartedError,
            verification: () => ({ client, installed: true }),
          }),
        addPlugin: () =>
          adapter.addPlugin(marketplacePath, (component, action) =>
            runEffect({
              step: `client-${client}-${component}`,
              intent: { client, component },
              action,
              verification: () => ({ client, component, installed: true }),
            }),
          ),
        verify: async () => {
          const registration = await adapter.readMcp();
          await verifyClientIntegration({
            client,
            vendorExecutable,
            installationId,
            registration,
            expectedLauncher: installed.launcherPath,
            environment,
            inventory: () => adapter.readInventory(marketplacePath),
            signal,
          });
        },
        removePlugin: () => recoveryAdapter().removePlugin(marketplacePath),
        removeMcp: () => recoveryAdapter().removeMcp(),
        revokeCredential: async (keyId, reference) => {
          const index = bridgeClients.findIndex(
            (entry) => entry.client === client,
          );
          if (index >= 0) bridgeClients.splice(index, 1);
          await persistBridgeState();
          if (reference.startsWith("secret-service:")) {
            await secretService.clear(installationId, client, reference);
          } else {
            await fallback.remove(reference as RestrictiveFileReference);
          }
          await revokeClientKeyInAdminContainer({
            dockerExecutable: "/usr/bin/docker",
            composePath,
            projectName,
            keyId,
            environment: dockerEnvironment,
          });
        },
        profileSnapshot: {
          client,
          profileRoot: setupRoots.home,
          stateRoot: dirname(setupRoots.stateRoot),
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
      clientResults.push(result);
      clientOwnership.push({
        client,
        result,
        credentialReference: currentReference,
        keyId: currentKeyId,
        marketplacePath,
      });
    }
    const status = clientResults.some(
      (result) => result.status === "recovery-required",
    )
      ? "recovery-required"
      : clientResults.some(
            (result) =>
              result.status !== "verified" &&
              result.status !== "external-verified",
          )
        ? "incomplete"
        : "success";
    const timestamp = new Date().toISOString();
    const selected = selectedClients(options.clients);
    const credentialOperationId = randomUUID();
    const clientStateRecords = clientOwnership
      .filter(
        ({ result }) =>
          result.status === "verified" || result.status === "external-verified",
      )
      .map((entry) => {
        const clientIntegrationId = randomUUID();
        const credentialReferenceId =
          entry.result.components.credential === "created" &&
          entry.credentialReference !== undefined &&
          entry.keyId !== undefined
            ? randomUUID()
            : null;
        const mcpIdentitySha256 = clientComponentIdentity({
          command: installed.launcherPath,
          args: [
            "bridge",
            "--installation",
            installationId,
            "--client",
            entry.client,
          ],
          scope: "user",
        });
        const adapterIdentitySha256 = clientComponentIdentity({
          plugin: "skillwire-autonomous-activation@skillwire",
          marketplacePath: entry.marketplacePath,
        });
        return {
          client: entry.client,
          integration: ClientIntegrationSchema.parse({
            schemaVersion: "skillwire.client-integration/v1",
            clientIntegrationId,
            installationId,
            client: entry.client,
            clientVersion: entry.client === "codex" ? "0.147.0" : "2.1.229",
            profileScope: "normal-user",
            state:
              entry.result.status === "external-verified"
                ? "external-verified"
                : "verified",
            credentialReferenceId,
            keyPublicIdHash:
              entry.keyId === undefined
                ? null
                : createHash("sha256").update(entry.keyId).digest("hex"),
            mcpIdentitySha256,
            adapterIdentitySha256,
          }),
          credential:
            credentialReferenceId === null ||
            entry.credentialReference === undefined ||
            entry.keyId === undefined
              ? null
              : CredentialReferenceSchema.parse({
                  schemaVersion: "skillwire.credential-reference/v1",
                  credentialReferenceId,
                  installationId,
                  client: entry.client,
                  backend: entry.credentialReference.startsWith(
                    "secret-service:",
                  )
                    ? "secret-service"
                    : "restrictive-file",
                  locator: entry.credentialReference,
                  keyPublicIdHash: createHash("sha256")
                    .update(entry.keyId)
                    .digest("hex"),
                  createdByOperation: credentialOperationId,
                  state: "available",
                  fallbackRiskConfirmed:
                    !entry.credentialReference.startsWith("secret-service:"),
                }),
        };
      });
    const installation = InstallationSchema.parse({
      schemaVersion: "skillwire.installation/v1",
      installationId,
      ownerUid: process.getuid(),
      accountId,
      activeReleaseId: `${String(manifest.releaseSequence)}-${manifest.architecture}`,
      highestAcceptedReleaseSequence: verified.releaseSequence,
      activeTrustPolicySequence: verified.trustPolicySequence,
      endpoint: `unix://${socketPath}`,
      composeProject: projectName,
      postgresVolume: volumeName,
      selectedClients: selected,
      clientIntegrationIds: {
        codex:
          clientStateRecords.find(({ client }) => client === "codex")
            ?.integration.clientIntegrationId ?? null,
        claude:
          clientStateRecords.find(({ client }) => client === "claude")
            ?.integration.clientIntegrationId ?? null,
      },
      status:
        status === "recovery-required"
          ? "recovery-required"
          : status === "incomplete"
            ? "incomplete"
            : selected.length === 0
              ? "service-ready"
              : "complete",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastValidatedAt: status === "success" ? timestamp : null,
    });
    const serviceSecretSet = ServiceSecretSetSchema.parse({
      schemaVersion: "skillwire.service-secret-set/v1",
      serviceSecretSetId: randomUUID(),
      installationId,
      secrets: secretReferences,
      createdByOperation: randomUUID(),
      state: "available",
    });
    const ownershipOperationId = randomUUID();
    let ownership = createOwnershipLedger(installationId);
    const installedReleaseIdentity = await releaseDirectoryIdentity(
      installed.releaseRoot,
    );
    const installedLauncherIdentity = await ownedLauncherIdentity(
      installed.launcherPath,
    );
    for (const asset of [
      {
        kind: "release" as const,
        locator: installed.releaseRoot,
        identity: installedReleaseIdentity,
        retention: "retain-by-default" as const,
      },
      {
        kind: "trust-policy" as const,
        locator: `trust/${manifest.trustPolicy.path}`,
        identity: manifest.trustPolicy.sha256,
        retention: "retain-by-default" as const,
      },
      ...secretReferences.map((secret) => ({
        kind: "service-secret" as const,
        locator: `${installationId}/${secret.relativePath}`,
        identity: secret.identitySha256,
        retention: "retain-by-default" as const,
      })),
      {
        kind: "compose-project" as const,
        locator: projectName,
        identity: clientComponentIdentity({ projectName }),
        retention: "remove-on-uninstall" as const,
      },
      ...(["skillwire", "postgres"] as const).map((service) => ({
        kind: "container" as const,
        locator: `${projectName}:${service}`,
        identity: clientComponentIdentity({ projectName, service }),
        retention: "remove-on-uninstall" as const,
      })),
      {
        kind: "volume" as const,
        locator: volumeName,
        identity: clientComponentIdentity({ volumeName }),
        retention: "retain-by-default" as const,
      },
      {
        kind: "path" as const,
        locator: installed.launcherPath,
        identity: installedLauncherIdentity,
        retention: "remove-only-on-purge" as const,
      },
      {
        kind: "path" as const,
        locator: installationRoot,
        identity: clientComponentIdentity({ installationRoot }),
        retention: "remove-only-on-purge" as const,
      },
      {
        kind: "path" as const,
        locator: bridgeStateRoot,
        identity: clientComponentIdentity({ bridgeStateRoot }),
        retention: "remove-only-on-purge" as const,
      },
    ]) {
      ownership = recordOwnedAsset(ownership, {
        kind: asset.kind,
        client: null,
        locator: asset.locator,
        expectedIdentitySha256: asset.identity,
        createdByOperation: ownershipOperationId,
        retention: asset.retention,
        disposition: "present",
      });
    }
    for (const entry of clientOwnership) {
      if (
        entry.result.status !== "verified" &&
        entry.result.status !== "external-verified"
      ) {
        continue;
      }
      const mcpIdentity = clientComponentIdentity({
        command: installed.launcherPath,
        args: [
          "bridge",
          "--installation",
          installationId,
          "--client",
          entry.client,
        ],
        scope: "user",
      });
      const pluginIdentity = clientComponentIdentity({
        plugin: "skillwire-autonomous-activation@skillwire",
        marketplacePath: entry.marketplacePath,
      });
      if (entry.result.components.mcp === "created") {
        ownership = recordOwnedAsset(ownership, {
          kind: "mcp-entry",
          client: entry.client,
          locator: "skillwire:user",
          expectedIdentitySha256: mcpIdentity,
          createdByOperation: ownershipOperationId,
          retention: "remove-on-uninstall",
          disposition: "present",
        });
      } else if (entry.result.components.mcp === "external") {
        ownership = recordExternalIntegration(ownership, {
          schemaVersion: "skillwire.external-integration/v1",
          externalDependencyId: randomUUID(),
          client: entry.client,
          kind: "mcp-entry",
          scope: "user",
          observedIdentitySha256: mcpIdentity,
          verification: "equivalent",
          lastObservedAt: timestamp,
        });
      }
      if (entry.result.components.plugin === "created") {
        for (const kind of ["marketplace", "plugin"] as const) {
          ownership = recordOwnedAsset(ownership, {
            kind,
            client: entry.client,
            locator:
              kind === "marketplace"
                ? `skillwire:${entry.marketplacePath}`
                : "skillwire-autonomous-activation@skillwire",
            expectedIdentitySha256: pluginIdentity,
            createdByOperation: ownershipOperationId,
            retention: "remove-on-uninstall",
            disposition: "present",
          });
        }
      } else if (entry.result.components.plugin === "external") {
        for (const kind of ["marketplace", "plugin"] as const) {
          ownership = recordExternalIntegration(ownership, {
            schemaVersion: "skillwire.external-integration/v1",
            externalDependencyId: randomUUID(),
            client: entry.client,
            kind,
            scope: "user",
            observedIdentitySha256: pluginIdentity,
            verification: "equivalent",
            lastObservedAt: timestamp,
          });
        }
      }
      if (
        entry.result.components.credential === "created" &&
        entry.credentialReference !== undefined
      ) {
        ownership = recordOwnedAsset(ownership, {
          kind: "credential",
          client: entry.client,
          locator: entry.credentialReference,
          expectedIdentitySha256: clientComponentIdentity({
            reference: entry.credentialReference,
          }),
          createdByOperation: ownershipOperationId,
          retention: "retain-by-default",
          disposition: "present",
        });
      }
    }
    await runEffect({
      step: "final-state-publication",
      intent: { installationId, status },
      action: async () => {
        await atomicWriteJson(
          resolve(setupRoots.stateRoot, "installation.json"),
          installation,
          setupRoots.stateRoot,
        );
        await atomicWriteJson(
          resolve(setupRoots.stateRoot, "service-secret-set.json"),
          serviceSecretSet,
          setupRoots.stateRoot,
        );
        await atomicWriteJson(
          resolve(setupRoots.stateRoot, "ownership.json"),
          ownership.record,
          setupRoots.stateRoot,
        );
        await atomicWriteJson(
          resolve(setupRoots.stateRoot, "external-integrations.json"),
          {
            schemaVersion: "skillwire.external-integrations/v1",
            installationId,
            dependencies: ownership.externalIntegrations,
          },
          setupRoots.stateRoot,
        );
        await atomicWriteJson(
          resolve(setupRoots.stateRoot, "client-integrations.json"),
          {
            schemaVersion: "skillwire.client-integrations/v1",
            installationId,
            integrations: clientStateRecords.map(
              ({ integration }) => integration,
            ),
          },
          setupRoots.stateRoot,
        );
        await atomicWriteJson(
          resolve(setupRoots.stateRoot, "credential-references.json"),
          {
            schemaVersion: "skillwire.credential-references/v1",
            installationId,
            credentials: clientStateRecords
              .map(({ credential }) => credential)
              .filter((credential) => credential !== null),
          },
          setupRoots.stateRoot,
        );
        await atomicWriteJson(
          resolve(setupRoots.stateRoot, "deployment.json"),
          {
            schemaVersion: "skillwire.deployment/v1",
            installationId,
            releaseRoot: installed.releaseRoot,
            composePath,
            skillwireImage,
            postgresImage,
            databasePasswordFile,
            applicationPepperFile,
            runtimeSocketDirectory,
            socketPath,
            projectName,
            volumeName,
          },
          setupRoots.stateRoot,
        );
      },
      verification: () => ({ installationId, published: true }),
    });
    return {
      status,
      installationId,
      serviceReady: true,
      clients: clientResults,
    };
  } catch (error) {
    if (
      journal.entries.some(
        ({ phase }) => phase === "effect" || phase === "compensate",
      )
    ) {
      throw new ProductionSetupMutationError(
        "Setup failed after owned installation mutation began",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function runProductionSetup(
  options: GuidedSetupOptions & {
    readonly credentialBackend: SetupCredentialBackend | "not-selected";
    readonly previewHash?: string | undefined;
  },
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env,
  trustOverrides: ProductionTrustOverrides = {},
): Promise<GuidedSetupResult> {
  const setupRoots = roots(environment);
  let existingInstallation: z.infer<typeof InstallationSchema> | undefined;
  // Preserve the durable cancellation contract: even an already-aborted fresh
  // setup records intent/cancel before returning. Installed-state inspection is
  // therefore skipped until after the journal is available in that case.
  if (!signal.aborted) {
    try {
      const existing = await inspectInstalledStatus({
        stateRoot: setupRoots.stateRoot,
        signal,
      });
      existingInstallation = existing.installation;
      const requested = selectedClients(options.clients);
      if (
        (existing.installation.status === "service-ready" ||
          existing.installation.status === "complete") &&
        requested.every((client) =>
          existing.installation.selectedClients.includes(client),
        )
      ) {
        const unchangedClients = unchangedSetupClientResults(
          requested,
          existing.installation.installationId,
          await readProtectedSetupJson(
            resolve(setupRoots.stateRoot, "client-integrations.json"),
          ),
        );
        if (unchangedClients === undefined) {
          existingInstallation = existing.installation;
        } else {
          const candidate = await candidatePaths(environment);
          const verified = await verifyCandidate(
            candidate,
            setupRoots,
            trustOverrides,
            signal,
          );
          if (
            verified.releaseSequence !==
              existing.installation.highestAcceptedReleaseSequence ||
            verified.trustPolicySequence !==
              existing.installation.activeTrustPolicySequence
          ) {
            throw new Error(
              "Unchanged setup candidate differs from the installed release state",
            );
          }
          return {
            status: "success",
            installationId: existing.installation.installationId,
            serviceReady: true,
            clients: unchangedClients,
            changed: false,
          };
        }
      }
      if (existing.installation.status === "recovery-required")
        throw new Error(
          "Setup cannot bypass an installation that requires journal recovery",
        );
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) &&
        !(error instanceof Error && error.message.includes("ENOENT"))
      ) {
        throw error;
      }
    }
  }
  await mkdir(setupRoots.stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(setupRoots.runtimeRoot, { recursive: true, mode: 0o700 });
  const identity = await currentProcessIdentity();
  const lock = await InstallationLock.acquire(
    resolve(setupRoots.runtimeRoot, "locks"),
    "installation",
    identity,
  );
  const operationId = randomUUID();
  const journal = await OperationJournal.create(
    resolve(setupRoots.stateRoot, "operations"),
    operationId,
    "setup",
  );
  const previewHash =
    options.previewHash ??
    createHash("sha256")
      .update(
        JSON.stringify({
          clients: options.clients,
          credentialBackend: options.credentialBackend,
        }),
      )
      .digest("hex");
  await journal.intent("setup", {
    clients: options.clients,
    previewHash,
  });
  try {
    if (
      existingInstallation !== undefined &&
      existingInstallation.status !== "purged"
    ) {
      const current = (
        await inspectInstalledStatus({
          stateRoot: setupRoots.stateRoot,
          signal,
        })
      ).installation;
      if (
        current.installationId !== existingInstallation.installationId ||
        current.updatedAt !== existingInstallation.updatedAt ||
        current.status !== existingInstallation.status
      )
        throw new Error(
          "Installed setup state changed before lock acquisition",
        );
      const candidate = await candidatePaths(environment);
      const verified = await verifyCandidate(
        candidate,
        setupRoots,
        trustOverrides,
        signal,
      );
      if (
        verified.releaseSequence !== current.highestAcceptedReleaseSequence ||
        verified.trustPolicySequence !== current.activeTrustPolicySequence
      )
        throw new Error(
          "Repeated setup cannot replace the installed signed release; use upgrade",
        );
      const continued = await continueProductionSetup({
        setup: options,
        credentialBackend: options.credentialBackend,
        installation: current,
        home: setupRoots.home,
        dataRoot: setupRoots.dataRoot,
        stateRoot: setupRoots.stateRoot,
        runtimeRoot: setupRoots.runtimeRoot,
        launcherPath: setupRoots.launcherPath,
        environment,
        signal,
        journal,
      });
      await journal.commit({ status: "success" });
      return continued;
    }
    const result = await runProductionSetupUnlocked(
      options,
      signal,
      journal,
      environment,
      trustOverrides,
    );
    await journal.commit({ status: result.status });
    return result;
  } catch (error) {
    if (signal.aborted) {
      await journal.cancel({
        status: journal.hasUnprovenEffect() ? "recovery-required" : "cancelled",
      });
    } else {
      await journal.compensate("setup", { status: "recovery-required" });
    }
    throw error;
  } finally {
    await lock.release();
  }
}
