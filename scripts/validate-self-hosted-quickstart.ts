import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  verifyManifestPayload,
  verifySignedReleaseEnvelope,
} from "../src/onboarding/adapters/filesystem/release-verifier.js";
import {
  assertLocalDockerContext,
  dockerProcessEnvironment,
  pinLocalDockerEndpoint,
} from "../src/onboarding/adapters/docker/environment.js";
import {
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "../src/onboarding/adapters/process/command-runner.js";
import { clientComponentIdentity } from "../src/onboarding/adapters/clients/client-state.js";
import { verifyOwnershipRecord } from "../src/onboarding/domain/ownership.js";
import {
  pinVerifiedArchive,
  validateArchiveListings,
  verifyProductionComposeText,
  verifySelfHostedReleasePolicy,
} from "./verify-self-hosted-release.js";

interface QuickstartArguments {
  readonly manifest: string;
  readonly bundles: readonly string[];
  readonly archive: string;
  readonly policy: string;
  readonly trustedRoot: string;
  readonly cosign: string;
  readonly architecture: "amd64" | "arm64";
  readonly execute: boolean;
}

function parseArguments(argv: readonly string[]): QuickstartArguments {
  const values = new Map<string, string[]>();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--execute") {
      execute = true;
      continue;
    }
    const value = argv[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--"))
      throw new Error("Quickstart arguments are invalid");
    values.set(name, [...(values.get(name) ?? []), value]);
    index += 1;
  }
  const one = (name: string): string => {
    const entries = values.get(name);
    if (entries?.length !== 1)
      throw new Error(`${name} is required exactly once`);
    const path = entries.at(0);
    if (path === undefined) throw new Error(`${name} is unavailable`);
    if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
    return resolve(path);
  };
  const architecture = values.get("--architecture")?.[0];
  if (architecture !== "amd64" && architecture !== "arm64")
    throw new Error("--architecture must be amd64 or arm64");
  const bundleValues = values.get("--bundle") ?? [];
  if (bundleValues.some((path) => !isAbsolute(path)))
    throw new Error("--bundle must be absolute");
  const bundles = bundleValues.map((path) => resolve(path));
  if (bundles.length < 1 || bundles.length > 2)
    throw new Error("One or two exact release bundles are required");
  const allowed = new Set([
    "--manifest",
    "--bundle",
    "--archive",
    "--policy",
    "--trusted-root",
    "--cosign",
    "--architecture",
  ]);
  if ([...values.keys()].some((name) => !allowed.has(name)))
    throw new Error("Quickstart option is unsupported");
  return {
    manifest: one("--manifest"),
    bundles,
    archive: one("--archive"),
    policy: one("--policy"),
    trustedRoot: one("--trusted-root"),
    cosign: one("--cosign"),
    architecture,
    execute,
  };
}

const DeploymentSchema = z.looseObject({
  schemaVersion: z.literal("skillwire.deployment/v1"),
  installationId: z.uuid(),
  composePath: z.string().startsWith("/"),
  projectName: z.string().regex(/^skillwire-[a-f0-9]{32}$/),
  volumeName: z.string().regex(/^skillwire-[a-f0-9]{32}_postgres_data$/),
  skillwireImage: z.string().regex(/@sha256:[0-9a-f]{64}$/),
  postgresImage: z.string().regex(/@sha256:[0-9a-f]{64}$/),
  databasePasswordFile: z.string().startsWith("/"),
  applicationPepperFile: z.string().startsWith("/"),
  runtimeSocketDirectory: z.string().startsWith("/"),
});

export function quickstartCleanupPlan(
  value: unknown,
  ownershipValue: unknown,
): {
  readonly deployment: z.infer<typeof DeploymentSchema>;
  readonly args: readonly string[];
} {
  const deployment = DeploymentSchema.parse(value);
  const installationProject = `skillwire-${deployment.installationId.replaceAll("-", "")}`;
  if (
    deployment.projectName !== installationProject ||
    deployment.volumeName !== `${deployment.projectName}_postgres_data`
  )
    throw new Error("Quickstart cleanup identity is inconsistent");
  const ownership = verifyOwnershipRecord(ownershipValue);
  if (ownership.installationId !== deployment.installationId)
    throw new Error(
      "Quickstart cleanup ownership belongs to another installation",
    );
  const required = [
    {
      kind: "compose-project",
      locator: deployment.projectName,
      identity: clientComponentIdentity({
        projectName: deployment.projectName,
      }),
    },
    ...(["skillwire", "postgres"] as const).map((service) => ({
      kind: "container",
      locator: `${deployment.projectName}:${service}`,
      identity: clientComponentIdentity({
        projectName: deployment.projectName,
        service,
      }),
    })),
    {
      kind: "volume",
      locator: deployment.volumeName,
      identity: clientComponentIdentity({ volumeName: deployment.volumeName }),
    },
  ];
  for (const expected of required) {
    const matches = ownership.assets.filter(
      ({ kind, client, locator, disposition, expectedIdentitySha256 }) =>
        kind === expected.kind &&
        client === null &&
        locator === expected.locator &&
        disposition === "present" &&
        expectedIdentitySha256 === expected.identity,
    );
    if (matches.length !== 1)
      throw new Error("Quickstart cleanup ownership is missing or ambiguous");
  }
  return {
    deployment,
    args: [
      "compose",
      "--project-name",
      deployment.projectName,
      "--file",
      "-",
      "down",
      "--volumes",
    ],
  };
}

export async function cleanupQuickstartDeployment(
  value: unknown,
  ownershipValue: unknown,
  environment: NodeJS.ProcessEnv,
  run: (options: CommandOptions) => Promise<CommandResult> = runCommand,
): Promise<void> {
  const { deployment, args } = quickstartCleanupPlan(value, ownershipValue);
  const composeText = await readProtectedQuickstartCompose(
    deployment.composePath,
  );
  verifyProductionComposeText(composeText);
  const commandEnvironment = dockerProcessEnvironment(environment, {
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
  const invoke = async (
    commandArgs: readonly string[],
    stdin?: string,
  ): Promise<CommandResult> => {
    const result = await run({
      executable: "/usr/bin/docker",
      args: commandArgs,
      environment: commandEnvironment,
      deadlineMilliseconds: 120_000,
      maximumOutputBytes: 256 * 1024,
      ...(stdin === undefined ? {} : { stdin }),
    });
    if (result.code !== 0)
      throw new Error("Quickstart Docker ownership verification failed");
    return result;
  };
  const listed = await invoke([
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${deployment.projectName}`,
  ]);
  const identities = listed.stdout.trim().split("\n").filter(Boolean);
  if (
    identities.length < 2 ||
    identities.length > 3 ||
    identities.some((identity) => !/^[0-9a-f]{64}$/.test(identity))
  ) {
    throw new Error("Quickstart Compose project ownership is ambiguous");
  }
  const expectedImages = new Map([
    ["skillwire", deployment.skillwireImage],
    ["postgres", deployment.postgresImage],
    ["migrate", deployment.skillwireImage],
  ]);
  const observedServices = new Set<string>();
  for (const identity of identities) {
    const inspected = await invoke([
      "container",
      "inspect",
      identity,
      "--format",
      '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Config.Image}}',
    ]);
    const [project, service, image] = inspected.stdout.trim().split("|");
    const expectedImage =
      service === undefined ? undefined : expectedImages.get(service);
    if (
      project !== deployment.projectName ||
      service === undefined ||
      expectedImage === undefined ||
      image !== expectedImage ||
      observedServices.has(service)
    )
      throw new Error(
        "Quickstart found an unrecorded or drifted Compose service",
      );
    observedServices.add(service);
  }
  if (!observedServices.has("skillwire") || !observedServices.has("postgres"))
    throw new Error("Quickstart Compose project is incomplete");
  const volume = await invoke([
    "volume",
    "inspect",
    deployment.volumeName,
    "--format",
    '{{.Name}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}',
  ]);
  if (
    volume.stdout.trim() !==
    `${deployment.volumeName}|${deployment.projectName}|postgres_data`
  ) {
    throw new Error("Quickstart PostgreSQL volume identity drifted");
  }
  await invoke(args, composeText);
}

export async function runQuickstartPostSetupChecks(options: {
  readonly launcher: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly run?: typeof runCommand | undefined;
  readonly cleanup: () => Promise<void>;
}): Promise<void> {
  const run = options.run ?? runCommand;
  let operationFailure: unknown;
  try {
    for (const command of ["status", "doctor"] as const) {
      await run({
        executable: options.launcher,
        args: [command, "--output", "json"],
        environment: options.environment,
        deadlineMilliseconds: 120_000,
        maximumOutputBytes: 256 * 1024,
      });
    }
  } catch (error) {
    operationFailure = error;
  }
  await options.cleanup();
  if (operationFailure instanceof Error) throw operationFailure;
  if (operationFailure !== undefined)
    throw new Error("Quickstart post-setup verification failed", {
      cause: operationFailure,
    });
}

async function readProtectedQuickstartJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > 1024 * 1024
    ) {
      throw new Error("Quickstart state is unsafe");
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

async function readProtectedQuickstartCompose(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o022) !== 0 ||
      stats.size < 1 ||
      stats.size > 256 * 1024
    ) {
      throw new Error("Quickstart Compose policy is unsafe");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function validateSelfHostedQuickstart(
  options: QuickstartArguments,
): Promise<Readonly<Record<string, unknown>>> {
  const primaryBundle = options.bundles.at(0);
  if (primaryBundle === undefined) throw new Error("Release bundle is missing");
  const verified = await verifySignedReleaseEnvelope({
    manifestPath: options.manifest,
    bundlePath: primaryBundle,
    bundlePaths: options.bundles,
    archive: options.archive,
    policyPath: options.policy,
    trustedRootPath: options.trustedRoot,
    cosign: options.cosign,
    architecture: options.architecture,
    currentReleaseSequence: 0,
    currentTrustSequence: 0,
  });
  const privateRoot = await mkdtemp(resolve(tmpdir(), "skillwire-quickstart-"));
  const releaseRoot = resolve(
    privateRoot,
    `skillwire-${verified.releaseVersion}-linux-${options.architecture}`,
  );
  const pinnedArchive = resolve(privateRoot, "candidate.tar.zst");
  let cleanupComplete = true;
  let pendingCleanup: unknown;
  let pendingOwnership: unknown;
  let pendingEnvironment: NodeJS.ProcessEnv | undefined;
  try {
    await mkdir(releaseRoot, { mode: 0o700 });
    await pinVerifiedArchive(
      options.archive,
      pinnedArchive,
      verified.manifest.archive.size,
      verified.archiveSha256,
    );
    const listing = await runCommand({
      executable: "/usr/bin/tar",
      args: ["--use-compress-program=/usr/bin/zstd", "-tf", pinnedArchive],
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      deadlineMilliseconds: 30_000,
      maximumOutputBytes: 512 * 1024,
    });
    const verbose = await runCommand({
      executable: "/usr/bin/tar",
      args: ["--use-compress-program=/usr/bin/zstd", "-tvf", pinnedArchive],
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      deadlineMilliseconds: 30_000,
      maximumOutputBytes: 512 * 1024,
    });
    validateArchiveListings(listing.stdout, verbose.stdout);
    await runCommand({
      executable: "/usr/bin/tar",
      args: [
        "--use-compress-program=/usr/bin/zstd",
        "--no-same-owner",
        "--no-same-permissions",
        "-xf",
        pinnedArchive,
        "-C",
        releaseRoot,
      ],
      environment: { PATH: "/usr/bin:/bin", LANG: "C" },
      deadlineMilliseconds: 60_000,
      maximumOutputBytes: 64 * 1024,
    });
    await verifyManifestPayload(verified.manifest, releaseRoot);
    await verifySelfHostedReleasePolicy(verified.manifest, releaseRoot);
    if (!options.execute) {
      cleanupComplete = true;
      return {
        verified: true,
        executed: false,
        manifestSha256: verified.manifestSha256,
        archiveSha256: verified.archiveSha256,
      };
    }

    const home = resolve(privateRoot, "home");
    const data = resolve(privateRoot, "xdg/data");
    const state = resolve(privateRoot, "xdg/state");
    const runtime = resolve(privateRoot, "xdg/runtime");
    await Promise.all(
      [home, data, state, runtime].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    );
    const dockerEndpoint = await assertLocalDockerContext({
      dockerExecutable: "/usr/bin/docker",
      environment: process.env,
      signal: new AbortController().signal,
    });
    const environment: NodeJS.ProcessEnv = pinLocalDockerEndpoint(
      {
        HOME: home,
        XDG_DATA_HOME: data,
        XDG_STATE_HOME: state,
        XDG_RUNTIME_DIR: runtime,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        SKILLWIRE_RELEASE_ROOT: releaseRoot,
      },
      dockerEndpoint,
    );
    const launcher = resolve(releaseRoot, "bin/skillwire");
    const preview = await runCommand({
      executable: launcher,
      args: [
        "setup",
        "--clients",
        "none",
        "--preview-only",
        "--output",
        "json",
      ],
      environment,
      deadlineMilliseconds: 120_000,
      maximumOutputBytes: 256 * 1024,
    });
    const previewResult = z
      .looseObject({ previewHash: z.string().regex(/^[0-9a-f]{64}$/) })
      .parse(JSON.parse(preview.stdout) as unknown);
    cleanupComplete = false;
    const setup = await runCommand({
      executable: launcher,
      args: [
        "setup",
        "--clients",
        "none",
        "--confirm-preview",
        previewResult.previewHash,
        "--output",
        "json",
      ],
      environment,
      deadlineMilliseconds: 600_000,
      maximumOutputBytes: 256 * 1024,
    });
    const setupResult = z
      .looseObject({ status: z.literal("success") })
      .parse(JSON.parse(setup.stdout) as unknown);
    const deploymentValue = await readProtectedQuickstartJson(
      resolve(state, "skillwire/deployment.json"),
    );
    const ownershipValue = await readProtectedQuickstartJson(
      resolve(state, "skillwire/ownership.json"),
    );
    const cleanup = quickstartCleanupPlan(deploymentValue, ownershipValue);
    const { deployment } = cleanup;
    pendingCleanup = deployment;
    pendingOwnership = ownershipValue;
    pendingEnvironment = environment;
    process.stderr.write(
      `Quickstart confirmed exact owned cleanup targets: project=${deployment.projectName} volume=${deployment.volumeName}\n`,
    );
    await runQuickstartPostSetupChecks({
      launcher,
      environment,
      cleanup: async () => {
        await cleanupQuickstartDeployment(
          deployment,
          ownershipValue,
          environment,
        );
        pendingCleanup = undefined;
        pendingOwnership = undefined;
        cleanupComplete = true;
      },
    });
    return {
      verified: true,
      executed: true,
      setupStatus: setupResult.status,
      cleanupProject: deployment.projectName,
      cleanupVolume: deployment.volumeName,
    };
  } finally {
    if (
      !cleanupComplete &&
      pendingCleanup !== undefined &&
      pendingOwnership !== undefined &&
      pendingEnvironment !== undefined
    ) {
      try {
        await cleanupQuickstartDeployment(
          pendingCleanup,
          pendingOwnership,
          pendingEnvironment,
        );
        pendingCleanup = undefined;
        pendingOwnership = undefined;
        cleanupComplete = true;
      } catch {
        // Preserve the private root only when exact named cleanup itself fails.
      }
    }
    if (cleanupComplete)
      await rm(privateRoot, { recursive: true, force: true });
    else
      process.stderr.write(
        `Quickstart stopped; inspect the retained private recovery root: ${privateRoot}\n`,
      );
  }
}

async function main(): Promise<void> {
  const result = await validateSelfHostedQuickstart(
    parseArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Quickstart validation failed"}\n`,
    );
    process.exitCode = 1;
  });
}
