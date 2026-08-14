import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import type { CandidateClassification } from "../../domain/external-catalog/types.js";
import { SourceRegistrationService } from "../../application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../../application/services/source-synchronization-service.js";
import type { ExternalCatalogStore } from "../../application/ports/external-catalog-store.js";
import type { GitHubSourceProvider } from "../../application/ports/github-source-provider.js";
import {
  runCommand,
  type CommandOptions,
} from "../adapters/process/command-runner.js";
import { clientComponentIdentity } from "../adapters/clients/client-state.js";
import {
  assertLocalDockerContext,
  dockerProcessEnvironment,
  pinLocalDockerEndpoint,
} from "../adapters/docker/environment.js";
import { atomicWriteJson } from "../adapters/filesystem/atomic-state.js";
import { GitHubTokenCredentialStore } from "../adapters/credentials/github-token.js";
import {
  BOOTSTRAP_SOURCES,
  SourceChoiceSchema,
  sourceCoordinate,
  type BootstrapSource,
  type SourceChoice,
} from "../domain/source-choice.js";
import {
  currentProcessIdentity,
  InstallationLock,
} from "../domain/operation-journal.js";
import {
  recordOwnedAsset,
  verifyOwnershipRecord,
} from "../domain/ownership.js";

export interface SelectedBootstrapSource {
  readonly source: BootstrapSource;
  readonly credentialReferenceId: string;
}

export interface ExistingSourceRegistration {
  readonly sourceId: string;
  readonly owner: string;
  readonly repository: string;
  readonly syncState?: SourceChoice["syncState"] | undefined;
}

export interface SourceBootstrapSyncResult {
  readonly sourceId: string;
  readonly classifications: readonly (CandidateClassification | "revoked")[];
  readonly created: boolean;
  readonly evidence?: Readonly<Record<string, string | number>> | undefined;
}

export interface SourceBootstrapDependencies {
  listRegistrations(
    signal: AbortSignal,
  ): Promise<readonly ExistingSourceRegistration[]>;
  register(
    coordinate: { readonly owner: string; readonly repository: string },
    credentialReferenceId: string,
    signal: AbortSignal,
  ): Promise<{ readonly sourceId: string; readonly created: boolean }>;
  synchronize(
    sourceId: string,
    credentialReferenceId: string,
    signal: AbortSignal,
  ): Promise<SourceBootstrapSyncResult>;
}

export class ProductionSourceBootstrapError extends Error {
  public constructor(
    message: string,
    readonly changed: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProductionSourceBootstrapError";
  }
}

function unselected(source: BootstrapSource): SourceChoice {
  return SourceChoiceSchema.parse({
    schemaVersion: "skillwire.source-choice/v1",
    sourceChoiceId: randomUUID(),
    source,
    selected: false,
    credentialReferenceId: null,
    registrationIdentity: null,
    syncState: "not-selected",
  });
}

export function sourceChoices(
  selected: readonly SelectedBootstrapSource[],
): readonly SourceChoice[] {
  const selections = new Map(selected.map((choice) => [choice.source, choice]));
  if (selections.size !== selected.length)
    throw new Error("Bootstrap source selection contains duplicates");
  return BOOTSTRAP_SOURCES.map((source) => {
    const choice = selections.get(source);
    if (choice === undefined) return unselected(source);
    return SourceChoiceSchema.parse({
      schemaVersion: "skillwire.source-choice/v1",
      sourceChoiceId: randomUUID(),
      source,
      selected: true,
      credentialReferenceId: choice.credentialReferenceId,
      registrationIdentity: null,
      syncState: "failed",
    });
  });
}

function syncState(
  classifications: SourceBootstrapSyncResult["classifications"],
): SourceChoice["syncState"] {
  if (
    classifications.some(
      (classification) =>
        classification === "quarantined" || classification === "revoked",
    )
  )
    return "quarantined";
  if (
    classifications.length > 0 &&
    classifications.every(
      (classification) =>
        classification === "verified" || classification === "curated",
    )
  )
    return "eligible";
  return "verifying";
}

export async function bootstrapSources(
  selected: readonly SelectedBootstrapSource[],
  dependencies: SourceBootstrapDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<readonly SourceChoice[]> {
  const choices = sourceChoices(selected);
  if (selected.length === 0) return choices;
  signal.throwIfAborted();
  const registrations = await dependencies.listRegistrations(signal);
  const results: SourceChoice[] = [];
  for (const choice of choices) {
    if (!choice.selected) {
      results.push(choice);
      continue;
    }
    if (choice.credentialReferenceId === null)
      throw new Error("Selected source credential reference is missing");
    const credentialReferenceId = choice.credentialReferenceId;
    signal.throwIfAborted();
    const coordinate = sourceCoordinate(choice.source);
    const existing = registrations.find(
      ({ owner, repository }) =>
        owner.toLowerCase() === coordinate.owner &&
        repository.toLowerCase() === coordinate.repository,
    );
    let registrationIdentity = existing?.sourceId ?? null;
    try {
      if (
        registrationIdentity !== null &&
        existing?.syncState !== undefined &&
        ["eligible", "quarantined", "verifying"].includes(existing.syncState)
      ) {
        results.push(
          SourceChoiceSchema.parse({
            ...choice,
            registrationIdentity,
            syncState: existing.syncState,
          }),
        );
        continue;
      }
      registrationIdentity ??= (
        await dependencies.register(coordinate, credentialReferenceId, signal)
      ).sourceId;
      const synchronized = await dependencies.synchronize(
        registrationIdentity,
        credentialReferenceId,
        signal,
      );
      if (synchronized.sourceId !== registrationIdentity)
        throw new Error("SOURCE_IDENTITY_MISMATCH");
      results.push(
        SourceChoiceSchema.parse({
          ...choice,
          registrationIdentity,
          syncState: syncState(synchronized.classifications),
        }),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      results.push(
        SourceChoiceSchema.parse({
          ...choice,
          registrationIdentity,
          syncState: registrationIdentity === null ? "failed" : "degraded",
        }),
      );
    }
  }
  return Object.freeze(results);
}

export function existingIngestionSourceDependencies(options: {
  readonly store: ExternalCatalogStore;
  readonly credentialStore: {
    lookup(reference: string, signal?: AbortSignal): Promise<string>;
  };
  readonly provider: (token: string) => GitHubSourceProvider;
  readonly actorId: string;
}): SourceBootstrapDependencies {
  const credential = (
    referenceId: string,
    signal: AbortSignal,
  ): Promise<string> =>
    options.credentialStore.lookup(
      `secret-service:github:${referenceId}`,
      signal,
    );
  return {
    listRegistrations: async (signal) => {
      signal.throwIfAborted();
      const [registrations, administrative] = await Promise.all([
        options.store.listSources({ signal }),
        options.store.listAdministrativeSources(undefined, { signal }),
      ]);
      return registrations.map(({ sourceId, repository }) => {
        const classification = administrative.find(
          (source) => source.sourceId === sourceId,
        )?.classification;
        return {
          sourceId,
          owner: repository.owner,
          repository: repository.repository,
          ...(classification === undefined
            ? {}
            : { syncState: syncState([classification]) }),
        };
      });
    },
    register: async (coordinate, credentialReferenceId, signal) => {
      const token = await credential(credentialReferenceId, signal);
      const service = new SourceRegistrationService(
        options.provider(token),
        options.store,
      );
      const registration = await service.add(coordinate, options.actorId, {
        signal,
      });
      return {
        sourceId: registration.sourceId,
        created: registration.created,
      };
    },
    synchronize: async (sourceId, credentialReferenceId, signal) => {
      const token = await credential(credentialReferenceId, signal);
      const service = new SourceSynchronizationService(
        options.provider(token),
        options.store,
      );
      const snapshot = await service.sync(sourceId, { signal });
      return {
        sourceId: snapshot.sourceId,
        classifications: snapshot.candidateTraces.map(
          ({ classification }) => classification,
        ),
        created: snapshot.created,
      };
    },
  };
}

const ContainerBootstrapResultSchema = z
  .object({
    schemaVersion: z.literal("skillwire.source-bootstrap-result/v1"),
    sourceId: z.uuid(),
    registrationCreated: z.boolean(),
    snapshotCreated: z.boolean(),
    classifications: z.array(
      z.enum(["discovered", "verified", "quarantined", "curated"]),
    ),
  })
  .strict();

export async function bootstrapSourceInAdminContainer(options: {
  readonly source: BootstrapSource;
  readonly token: string;
  readonly dockerExecutable: string;
  readonly composePath: string;
  readonly projectName: string;
  readonly databasePasswordFile: string;
  readonly applicationPepperFile: string;
  readonly runtimeSocketDirectory: string;
  readonly volumeName: string;
  readonly skillwireImage: string;
  readonly postgresImage: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal | undefined;
  readonly run?:
    | ((options: CommandOptions) => Promise<{
        readonly stdout: string;
        readonly stderr: string;
        readonly code: number;
      }>)
    | undefined;
}): Promise<SourceBootstrapSyncResult> {
  if (
    !isAbsolute(options.dockerExecutable) ||
    !isAbsolute(options.composePath) ||
    !isAbsolute(options.databasePasswordFile) ||
    !isAbsolute(options.applicationPepperFile) ||
    !isAbsolute(options.runtimeSocketDirectory) ||
    options.databasePasswordFile.includes(":") ||
    !/^skillwire-[a-z0-9-]+$/.test(options.projectName) ||
    options.volumeName !== `${options.projectName}_postgres_data` ||
    !/^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$/.test(options.skillwireImage) ||
    !/^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$/.test(options.postgresImage)
  ) {
    throw new Error("Source bootstrap deployment identity is invalid");
  }
  const coordinate = sourceCoordinate(options.source);
  const run = options.run ?? runCommand;
  const result = await run({
    executable: resolve(options.dockerExecutable),
    args: [
      "compose",
      "--project-name",
      options.projectName,
      "--file",
      options.composePath,
      "run",
      "--rm",
      "--no-TTY",
      "--no-deps",
      "--user",
      `${String(process.getuid?.() ?? 10001)}:${String(process.getgid?.() ?? 10001)}`,
      "--entrypoint",
      "node",
      "--volume",
      `${options.databasePasswordFile}:/run/skillwire-source/database-password:ro`,
      "--env",
      "SKILLWIRE_DATABASE_PASSWORD_FILE=/run/skillwire-source/database-password",
      "admin",
      "dist/src/ingestion/bootstrap-cli.js",
      coordinate.owner,
      coordinate.repository,
    ],
    environment: dockerProcessEnvironment(options.environment, {
      SKILLWIRE_COMPOSE_PROJECT: options.projectName,
      SKILLWIRE_POSTGRES_VOLUME: options.volumeName,
      SKILLWIRE_IMAGE: options.skillwireImage,
      SKILLWIRE_POSTGRES_IMAGE: options.postgresImage,
      SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE: options.databasePasswordFile,
      SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE: options.applicationPepperFile,
      SKILLWIRE_RUNTIME_SOCKET_DIRECTORY: options.runtimeSocketDirectory,
      SKILLWIRE_RUNTIME_UID: String(process.getuid?.() ?? 10001),
      SKILLWIRE_RUNTIME_GID: String(process.getgid?.() ?? 10001),
    }),
    stdin: options.token,
    deadlineMilliseconds: 320_000,
    maximumOutputBytes: 64 * 1024,
    signal: options.signal,
  });
  const parsed = ContainerBootstrapResultSchema.parse(
    JSON.parse(result.stdout) as unknown,
  );
  return {
    sourceId: parsed.sourceId,
    classifications: parsed.classifications,
    created: parsed.registrationCreated || parsed.snapshotCreated,
  };
}

const SourceChoiceStateSchema = z
  .object({
    schemaVersion: z.literal("skillwire.source-choices/v1"),
    installationId: z.uuid(),
    choices: z.array(SourceChoiceSchema).length(2),
  })
  .strict();

const ProductionSourceDeploymentSchema = z.looseObject({
  schemaVersion: z.literal("skillwire.deployment/v1"),
  installationId: z.uuid(),
  composePath: z.string().refine(isAbsolute),
  projectName: z.string().regex(/^skillwire-[a-z0-9-]+$/),
  databasePasswordFile: z.string().refine(isAbsolute),
  applicationPepperFile: z.string().refine(isAbsolute),
  runtimeSocketDirectory: z.string().refine(isAbsolute),
  volumeName: z.string().regex(/^skillwire-[a-z0-9-]+_postgres_data$/),
  skillwireImage: z.string().regex(/^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$/),
  postgresImage: z.string().regex(/^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$/),
});

async function readProtectedJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > 128 * 1024
    ) {
      throw new Error("Source bootstrap state is unsafe");
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

export async function readProductionSourceDeployment(
  stateRoot: string,
): Promise<ProductionSourceDeployment> {
  const parsed = ProductionSourceDeploymentSchema.parse(
    await readProtectedJson(resolve(stateRoot, "deployment.json")),
  );
  return {
    installationId: parsed.installationId,
    composePath: parsed.composePath,
    projectName: parsed.projectName,
    databasePasswordFile: parsed.databasePasswordFile,
    applicationPepperFile: parsed.applicationPepperFile,
    runtimeSocketDirectory: parsed.runtimeSocketDirectory,
    volumeName: parsed.volumeName,
    skillwireImage: parsed.skillwireImage,
    postgresImage: parsed.postgresImage,
  };
}

export async function readProtectedSourceChoices(
  path: string,
): Promise<z.infer<typeof SourceChoiceStateSchema> | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
      stats.size > 128 * 1024
    ) {
      throw new Error("Source choice state is unsafe");
    }
    return SourceChoiceStateSchema.parse(
      JSON.parse(await handle.readFile("utf8")) as unknown,
    );
  } finally {
    await handle.close();
  }
}

export interface ProductionSourceDeployment {
  readonly installationId: string;
  readonly composePath: string;
  readonly projectName: string;
  readonly databasePasswordFile: string;
  readonly applicationPepperFile: string;
  readonly runtimeSocketDirectory: string;
  readonly volumeName: string;
  readonly skillwireImage: string;
  readonly postgresImage: string;
}

interface ProductionSourceBootstrapOptions {
  readonly selected: readonly BootstrapSource[];
  readonly deployment: ProductionSourceDeployment;
  readonly stateRoot: string;
  readonly runtimeRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly token?: string | undefined;
  readonly signal: AbortSignal;
  readonly operationId?: string | undefined;
  readonly credentialStore?:
    Pick<GitHubTokenCredentialStore, "store" | "lookup" | "clear"> | undefined;
  readonly bootstrap?: typeof bootstrapSourceInAdminContainer | undefined;
  readonly resolveDockerEnvironment?:
    | ((
        environment: NodeJS.ProcessEnv,
        signal: AbortSignal,
      ) => Promise<NodeJS.ProcessEnv>)
    | undefined;
}

async function bootstrapProductionSourcesUnlocked(
  options: ProductionSourceBootstrapOptions,
): Promise<{
  readonly choices: readonly SourceChoice[];
  readonly changed: boolean;
}> {
  if (options.selected.length === 0)
    return { choices: sourceChoices([]), changed: false };
  if (new Set(options.selected).size !== options.selected.length)
    throw new Error("Bootstrap source selection contains duplicates");
  const statePath = resolve(options.stateRoot, "source-choices.json");
  const ownershipPath = resolve(options.stateRoot, "ownership.json");
  const previous = await readProtectedSourceChoices(statePath);
  if (
    previous !== undefined &&
    previous.installationId !== options.deployment.installationId
  ) {
    throw new Error("Source choices belong to another installation");
  }
  const priorBySource = new Map(
    previous?.choices.map((choice) => [choice.source, choice]) ?? [],
  );
  let ownership = verifyOwnershipRecord(await readProtectedJson(ownershipPath));
  if (ownership.installationId !== options.deployment.installationId)
    throw new Error(
      "Source credential ownership belongs to another installation",
    );
  const ownedSourceCredentials = ownership.assets.filter(
    ({ kind, client, locator, disposition }) =>
      kind === "credential" &&
      client === null &&
      locator.startsWith("secret-service:github:") &&
      (disposition === "present" || disposition === "retained"),
  );
  if (ownedSourceCredentials.length > 1)
    throw new Error("Source credential ownership is ambiguous");
  const ownedSourceCredential = ownedSourceCredentials.at(0);
  if (
    ownedSourceCredential !== undefined &&
    ownedSourceCredential.expectedIdentitySha256 !==
      clientComponentIdentity({ reference: ownedSourceCredential.locator })
  ) {
    throw new Error("Source credential ownership identity is invalid");
  }
  const ownedReferenceId = ownedSourceCredential?.locator.split(":").at(-1);
  if (
    ownedReferenceId !== undefined &&
    !z.uuid().safeParse(ownedReferenceId).success
  )
    throw new Error("Source credential ownership reference is invalid");
  for (const source of options.selected) {
    const priorReferenceId = priorBySource.get(source)?.credentialReferenceId;
    if (
      priorReferenceId !== null &&
      priorReferenceId !== undefined &&
      priorReferenceId !== ownedReferenceId
    ) {
      throw new Error("Source state is not bound to owned credential metadata");
    }
  }
  const unchanged = options.selected.every((source) => {
    const prior = priorBySource.get(source);
    return (
      prior?.selected === true &&
      prior.credentialReferenceId !== null &&
      ["eligible", "quarantined", "verifying"].includes(prior.syncState)
    );
  });
  if (unchanged && previous !== undefined)
    return { choices: previous.choices, changed: false };

  const credentialStore =
    options.credentialStore ??
    new GitHubTokenCredentialStore("/usr/bin/secret-tool", options.environment);
  let stored:
    { readonly reference: string; readonly referenceId: string } | undefined;
  if (ownedSourceCredential !== undefined && ownedReferenceId !== undefined) {
    stored = {
      reference: ownedSourceCredential.locator,
      referenceId: ownedReferenceId,
    };
  }
  let changed = false;
  const completed = new Map<BootstrapSource, SourceChoice>();
  const choiceIds = new Map(
    BOOTSTRAP_SOURCES.map((source) => [
      source,
      priorBySource.get(source)?.sourceChoiceId ?? randomUUID(),
    ]),
  );
  const failedChoice = (
    source: BootstrapSource,
    credentialReferenceId: string | null,
  ): SourceChoice => {
    const prior = priorBySource.get(source);
    return SourceChoiceSchema.parse({
      schemaVersion: "skillwire.source-choice/v1",
      sourceChoiceId: choiceIds.get(source),
      source,
      selected: true,
      credentialReferenceId,
      registrationIdentity: prior?.registrationIdentity ?? null,
      syncState:
        prior?.registrationIdentity === undefined ||
        prior.registrationIdentity === null
          ? "failed"
          : "degraded",
    });
  };
  const currentChoices = (
    sharedCredentialReferenceId: string | null = null,
  ): readonly SourceChoice[] =>
    BOOTSTRAP_SOURCES.map((source) => {
      const result = completed.get(source);
      if (result !== undefined) return result;
      const prior = priorBySource.get(source);
      if (!options.selected.includes(source))
        return prior ?? unselected(source);
      return prior?.selected === true
        ? prior
        : failedChoice(source, sharedCredentialReferenceId);
    });
  const publish = async (
    sharedCredentialReferenceId: string | null = null,
  ): Promise<readonly SourceChoice[]> => {
    const choices = currentChoices(sharedCredentialReferenceId);
    await atomicWriteJson(
      statePath,
      {
        schemaVersion: "skillwire.source-choices/v1",
        installationId: options.deployment.installationId,
        choices,
      },
      options.stateRoot,
    );
    changed = true;
    return choices;
  };
  let choices = currentChoices();
  for (const source of BOOTSTRAP_SOURCES) {
    if (!options.selected.includes(source)) {
      continue;
    }
    const prior = priorBySource.get(source);
    if (
      prior?.selected === true &&
      prior.credentialReferenceId !== null &&
      ["eligible", "quarantined", "verifying"].includes(prior.syncState)
    ) {
      completed.set(source, prior);
      continue;
    }
    let credentialReferenceId = prior?.credentialReferenceId ?? null;
    let token: string | undefined;
    try {
      if (credentialReferenceId !== null) {
        token = await credentialStore.lookup(
          `secret-service:github:${credentialReferenceId}`,
          options.signal,
        );
      } else {
        if (stored === undefined) {
          if (options.token === undefined)
            throw new Error("GitHub source credential is unavailable");
          const candidate = await credentialStore.store(
            options.token,
            options.signal,
          );
          const next = recordOwnedAsset(
            { record: ownership, externalIntegrations: [] },
            {
              assetId: candidate.referenceId,
              kind: "credential",
              client: null,
              locator: candidate.reference,
              expectedIdentitySha256: clientComponentIdentity({
                reference: candidate.reference,
              }),
              createdByOperation: options.operationId ?? randomUUID(),
              retention: "remove-only-on-purge",
              disposition: "present",
            },
          ).record;
          try {
            await atomicWriteJson(ownershipPath, next, options.stateRoot);
            ownership = next;
          } catch (error) {
            const published = await readProtectedJson(ownershipPath)
              .then((value) =>
                verifyOwnershipRecord(value).assets.some(
                  ({ locator }) => locator === candidate.reference,
                ),
              )
              .catch(() => false);
            if (!published)
              await credentialStore
                .clear(candidate.reference)
                .catch(() => undefined);
            throw error;
          }
          stored = candidate;
          changed = true;
        }
        credentialReferenceId = stored.referenceId;
        token =
          options.token ??
          (await credentialStore.lookup(stored.reference, options.signal));
      }
      completed.set(source, failedChoice(source, credentialReferenceId));
      choices = await publish(stored?.referenceId ?? credentialReferenceId);
      const synchronized = await (
        options.bootstrap ?? bootstrapSourceInAdminContainer
      )({
        source,
        token,
        dockerExecutable: "/usr/bin/docker",
        composePath: options.deployment.composePath,
        projectName: options.deployment.projectName,
        databasePasswordFile: options.deployment.databasePasswordFile,
        applicationPepperFile: options.deployment.applicationPepperFile,
        runtimeSocketDirectory: options.deployment.runtimeSocketDirectory,
        volumeName: options.deployment.volumeName,
        skillwireImage: options.deployment.skillwireImage,
        postgresImage: options.deployment.postgresImage,
        environment: options.environment,
        signal: options.signal,
      });
      completed.set(
        source,
        SourceChoiceSchema.parse({
          schemaVersion: "skillwire.source-choice/v1",
          sourceChoiceId: choiceIds.get(source),
          source,
          selected: true,
          credentialReferenceId,
          registrationIdentity: synchronized.sourceId,
          syncState: syncState(synchronized.classifications),
        }),
      );
      choices = await publish(stored?.referenceId ?? credentialReferenceId);
    } catch (error) {
      completed.set(source, failedChoice(source, credentialReferenceId));
      choices = await publish(stored?.referenceId ?? credentialReferenceId);
      if (options.signal.aborted) {
        throw new ProductionSourceBootstrapError(
          "Source bootstrap cancelled at a persisted safe retry boundary",
          changed,
          { cause: error },
        );
      }
    }
  }
  return { choices: Object.freeze(choices), changed: true };
}

export async function bootstrapProductionSources(
  options: ProductionSourceBootstrapOptions,
): Promise<{
  readonly choices: readonly SourceChoice[];
  readonly changed: boolean;
}> {
  options.signal.throwIfAborted();
  const lock = await InstallationLock.acquire(
    resolve(options.runtimeRoot, "locks"),
    "installation",
    await currentProcessIdentity(),
  );
  try {
    options.signal.throwIfAborted();
    const resolveDockerEnvironment =
      options.resolveDockerEnvironment ??
      (async (environment: NodeJS.ProcessEnv, signal: AbortSignal) =>
        pinLocalDockerEndpoint(
          environment,
          await assertLocalDockerContext({
            dockerExecutable: "/usr/bin/docker",
            environment,
            signal,
          }),
        ));
    const environment = await resolveDockerEnvironment(
      options.environment,
      options.signal,
    );
    return await bootstrapProductionSourcesUnlocked({
      ...options,
      environment,
    });
  } finally {
    await lock.release();
  }
}
