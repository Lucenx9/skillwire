import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapSources,
  bootstrapProductionSources,
  readProtectedSourceChoices,
  sourceChoices,
} from "../../../src/onboarding/application/source-bootstrap.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { runGuidedSetup } from "../../../src/onboarding/application/setup.js";
import {
  currentProcessIdentity,
  InstallationLock,
} from "../../../src/onboarding/domain/operation-journal.js";
import { atomicWriteJson } from "../../../src/onboarding/adapters/filesystem/atomic-state.js";
import {
  createOwnershipLedger,
  verifyOwnershipRecord,
} from "../../../src/onboarding/domain/ownership.js";
import { previewPurge } from "../../../src/onboarding/application/purge.js";

async function seedOwnership(
  stateRoot: string,
  installationId: string,
): Promise<void> {
  await atomicWriteJson(
    resolve(stateRoot, "ownership.json"),
    createOwnershipLedger(installationId).record,
    stateRoot,
  );
}

describe("explicit source bootstrap", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => {
    await fixture?.close();
  });
  it("does nothing for the two offered sources unless explicitly selected", async () => {
    const register = vi.fn();
    const synchronize = vi.fn();
    const choices = sourceChoices([]);

    expect(
      choices.map(({ source, selected, syncState }) => ({
        source,
        selected,
        syncState,
      })),
    ).toEqual([
      {
        source: "mattpocock/skills",
        selected: false,
        syncState: "not-selected",
      },
      {
        source: "obra/superpowers",
        selected: false,
        syncState: "not-selected",
      },
    ]);
    expect(
      (
        await bootstrapSources([], {
          listRegistrations: () => Promise.resolve([]),
          register,
          synchronize,
        })
      ).map(({ source, selected, syncState }) => ({
        source,
        selected,
        syncState,
      })),
    ).toEqual(
      choices.map(({ source, selected, syncState }) => ({
        source,
        selected,
        syncState,
      })),
    );
    expect(register).not.toHaveBeenCalled();
    expect(synchronize).not.toHaveBeenCalled();
  });

  it.each(["mattpocock/skills", "obra/superpowers"] as const)(
    "registers %s once and never promotes quarantined content",
    async (source) => {
      const sourceId = randomUUID();
      const credentialReferenceId = randomUUID();
      const register = vi.fn().mockResolvedValue({ sourceId, created: true });
      const synchronize = vi.fn().mockResolvedValue({
        sourceId,
        classifications: ["quarantined", "verified"],
        created: true,
      });
      const dependencies = {
        listRegistrations: () => Promise.resolve([]),
        register,
        synchronize,
      };

      const first = await bootstrapSources(
        [{ source, credentialReferenceId }],
        dependencies,
      );

      expect(register).toHaveBeenCalledWith(
        source === "mattpocock/skills"
          ? { owner: "mattpocock", repository: "skills" }
          : { owner: "obra", repository: "superpowers" },
        credentialReferenceId,
        expect.any(AbortSignal),
      );
      expect(synchronize).toHaveBeenCalledWith(
        sourceId,
        credentialReferenceId,
        expect.any(AbortSignal),
      );
      expect(first.find((choice) => choice.source === source)).toMatchObject({
        selected: true,
        registrationIdentity: sourceId,
        syncState: "quarantined",
      });
      expect(first.find((choice) => choice.source !== source)).toMatchObject({
        selected: false,
        syncState: "not-selected",
      });

      register.mockClear();
      synchronize.mockClear();
      const [owner, repository] = source.split("/");
      if (owner === undefined || repository === undefined)
        throw new Error("Invalid source fixture");
      await bootstrapSources([{ source, credentialReferenceId }], {
        ...dependencies,
        listRegistrations: () =>
          Promise.resolve([
            {
              sourceId,
              owner,
              repository,
            },
          ]),
      });
      expect(register).not.toHaveBeenCalled();
      expect(synchronize).toHaveBeenCalledTimes(1);

      synchronize.mockClear();
      const unchanged = await bootstrapSources(
        [{ source, credentialReferenceId }],
        {
          ...dependencies,
          listRegistrations: () =>
            Promise.resolve([
              {
                sourceId,
                owner,
                repository,
                syncState: "eligible" as const,
              },
            ]),
        },
      );
      expect(register).not.toHaveBeenCalled();
      expect(synchronize).not.toHaveBeenCalled();
      expect(
        unchanged.find((choice) => choice.source === source),
      ).toMatchObject({
        registrationIdentity: sourceId,
        syncState: "eligible",
      });
    },
  );

  it("reports an all-verified imported snapshot as eligible", async () => {
    const sourceId = randomUUID();
    const [choice] = await bootstrapSources(
      [
        {
          source: "mattpocock/skills",
          credentialReferenceId: randomUUID(),
        },
      ],
      {
        listRegistrations: () => Promise.resolve([]),
        register: () => Promise.resolve({ sourceId, created: true }),
        synchronize: () =>
          Promise.resolve({
            sourceId,
            classifications: ["verified", "verified"],
            created: true,
          }),
      },
    );

    expect(choice).toMatchObject({
      source: "mattpocock/skills",
      syncState: "eligible",
    });
  });

  it("runs explicit sources only after first-party service readiness", async () => {
    const order: string[] = [];
    const credentialReferenceId = randomUUID();
    const result = await runGuidedSetup(
      {
        clients: "none",
        sources: ["mattpocock/skills"],
      },
      {
        verifyRelease: () => {
          order.push("release");
          return Promise.resolve({ releaseSequence: 1 });
        },
        installService: () => {
          order.push("service-ready");
          return Promise.resolve({ installationId: randomUUID(), ready: true });
        },
        installClient: () => Promise.reject(new Error("no client selected")),
        bootstrapSources: (selected) => {
          order.push("source-bootstrap");
          return Promise.resolve({
            choices: sourceChoices(
              selected.map((source) => ({ source, credentialReferenceId })),
            ).map((choice) =>
              choice.selected
                ? {
                    ...choice,
                    registrationIdentity: randomUUID(),
                    syncState: "eligible" as const,
                  }
                : choice,
            ),
            changed: true,
          });
        },
      },
    );

    expect(order).toEqual(["release", "service-ready", "source-bootstrap"]);
    expect(result.status).toBe("success");
    expect(result.sources?.find(({ selected }) => selected)).toMatchObject({
      source: "mattpocock/skills",
      syncState: "eligible",
    });
  });

  it("keeps a ready service but reports incomplete when an optional source degrades", async () => {
    const result = await runGuidedSetup(
      {
        clients: "none",
        sources: ["obra/superpowers"],
      },
      {
        inspectExisting: () =>
          Promise.resolve({
            status: "success" as const,
            installationId: randomUUID(),
            serviceReady: true,
            clients: [],
            changed: false,
          }),
        verifyRelease: () =>
          Promise.reject(new Error("unchanged setup must not reinstall")),
        installService: () =>
          Promise.reject(new Error("unchanged setup must not redeploy")),
        installClient: () => Promise.reject(new Error("no client selected")),
        bootstrapSources: (selected) =>
          Promise.resolve({
            choices: sourceChoices(
              selected.map((source) => ({
                source,
                credentialReferenceId: randomUUID(),
              })),
            ).map((choice) =>
              choice.selected
                ? {
                    ...choice,
                    registrationIdentity: randomUUID(),
                    syncState: "degraded" as const,
                  }
                : choice,
            ),
            changed: true,
          }),
      },
    );
    expect(result).toMatchObject({
      status: "incomplete",
      serviceReady: true,
      changed: true,
    });
  });

  it("preserves an unchanged setup result when source bootstrap is already converged", async () => {
    const installationId = randomUUID();
    const credentialReferenceId = randomUUID();
    const choices = sourceChoices([
      { source: "mattpocock/skills", credentialReferenceId },
    ]).map((choice) =>
      choice.selected
        ? {
            ...choice,
            registrationIdentity: randomUUID(),
            syncState: "eligible" as const,
          }
        : choice,
    );
    const result = await runGuidedSetup(
      { clients: "none", sources: ["mattpocock/skills"] },
      {
        inspectExisting: () =>
          Promise.resolve({
            status: "success" as const,
            installationId,
            serviceReady: true,
            clients: [],
            changed: false,
          }),
        verifyRelease: () => Promise.reject(new Error("must not verify")),
        installService: () => Promise.reject(new Error("must not deploy")),
        installClient: () => Promise.reject(new Error("must not install")),
        bootstrapSources: () => Promise.resolve({ choices, changed: false }),
      },
    );
    expect(result).toMatchObject({
      installationId,
      status: "success",
      changed: false,
      sources: choices,
    });
  });

  it("persists a post-readiness result and repeats without credentials, registration, or sync writes", async () => {
    fixture = await createOnboardingEnvironment();
    const stateRoot = `${fixture.xdgStateHome}/skillwire`;
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const sourceId = randomUUID();
    const installationId = randomUUID();
    const credentialReferenceId = randomUUID();
    await seedOwnership(stateRoot, installationId);
    const store = {
      store: vi.fn().mockResolvedValue({
        reference: `secret-service:github:${credentialReferenceId}`,
        referenceId: credentialReferenceId,
      }),
      lookup: vi.fn(),
      clear: vi.fn(),
    };
    const bootstrap = vi.fn().mockResolvedValue({
      sourceId,
      classifications: ["curated"],
      created: true,
    });
    const options = {
      selected: ["mattpocock/skills"] as const,
      deployment: {
        installationId,
        composePath: "/release/compose.yaml",
        projectName: "skillwire-1234567890abcdef",
        databasePasswordFile: "/state/database-password",
        applicationPepperFile: "/state/application-pepper",
        runtimeSocketDirectory: "/runtime/skillwire",
        volumeName: "skillwire-1234567890abcdef_postgres_data",
        skillwireImage: `ghcr.io/lucenx9/skillwire@sha256:${"1".repeat(64)}`,
        postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
      },
      stateRoot,
      runtimeRoot: resolve(fixture.runtimeRoot, "skillwire"),
      environment: fixture.environment,
      token: "github_pat_source_only_read_token",
      signal: new AbortController().signal,
      credentialStore: store,
      bootstrap,
      resolveDockerEnvironment: (environment: NodeJS.ProcessEnv) =>
        Promise.resolve(environment),
    };

    const first = await bootstrapProductionSources(options);
    expect(first).toMatchObject({ changed: true });
    expect(first.choices.find(({ selected }) => selected)).toMatchObject({
      registrationIdentity: sourceId,
      syncState: "eligible",
    });
    expect(store.store).toHaveBeenCalledTimes(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    const ownership = verifyOwnershipRecord(
      JSON.parse(
        await readFile(resolve(stateRoot, "ownership.json"), "utf8"),
      ) as unknown,
    );
    expect(ownership.assets).toContainEqual(
      expect.objectContaining({
        kind: "credential",
        client: null,
        locator: `secret-service:github:${credentialReferenceId}`,
        retention: "remove-only-on-purge",
      }),
    );
    expect(previewPurge(ownership).unrecoverable).toContainEqual(
      expect.objectContaining({
        locator: `secret-service:github:${credentialReferenceId}`,
      }),
    );

    store.store.mockClear();
    bootstrap.mockClear();
    const repeated = await bootstrapProductionSources({
      ...options,
      token: undefined,
    });
    expect(repeated.changed).toBe(false);
    expect(store.store).not.toHaveBeenCalled();
    expect(store.lookup).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("rejects a concurrent source mutation before storing a credential or starting ingestion", async () => {
    fixture = await createOnboardingEnvironment();
    const stateRoot = resolve(fixture.xdgStateHome, "skillwire");
    const runtimeRoot = resolve(fixture.runtimeRoot, "skillwire");
    await Promise.all([
      mkdir(stateRoot, { recursive: true, mode: 0o700 }),
      mkdir(runtimeRoot, { recursive: true, mode: 0o700 }),
    ]);
    const lock = await InstallationLock.acquire(
      resolve(runtimeRoot, "locks"),
      "installation",
      await currentProcessIdentity(),
    );
    const store = {
      store: vi.fn().mockResolvedValue({
        reference: `secret-service:github:${randomUUID()}`,
        referenceId: randomUUID(),
      }),
      lookup: vi.fn(),
      clear: vi.fn(),
    };
    const bootstrap = vi.fn();
    try {
      await expect(
        bootstrapProductionSources({
          selected: ["obra/superpowers"],
          deployment: {
            installationId: randomUUID(),
            composePath: "/release/compose.yaml",
            projectName: "skillwire-1234567890abcdef",
            databasePasswordFile: "/state/database-password",
            applicationPepperFile: "/state/application-pepper",
            runtimeSocketDirectory: "/runtime/skillwire",
            volumeName: "skillwire-1234567890abcdef_postgres_data",
            skillwireImage: `ghcr.io/lucenx9/skillwire@sha256:${"1".repeat(64)}`,
            postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
          },
          stateRoot,
          runtimeRoot,
          environment: fixture.environment,
          token: "github_pat_source_only_read_token",
          signal: new AbortController().signal,
          credentialStore: store,
          bootstrap,
          resolveDockerEnvironment: (environment: NodeJS.ProcessEnv) =>
            Promise.resolve(environment),
        }),
      ).rejects.toThrow(/locked/i);
      expect(store.store).not.toHaveBeenCalled();
      expect(store.lookup).not.toHaveBeenCalled();
      expect(bootstrap).not.toHaveBeenCalled();
    } finally {
      await lock.release();
    }
  });

  it("rejects a remote Docker context before credential or source effects", async () => {
    fixture = await createOnboardingEnvironment();
    const stateRoot = resolve(fixture.xdgStateHome, "skillwire");
    const runtimeRoot = resolve(fixture.runtimeRoot, "skillwire");
    await Promise.all([
      mkdir(stateRoot, { recursive: true, mode: 0o700 }),
      mkdir(runtimeRoot, { recursive: true, mode: 0o700 }),
    ]);
    const store = { store: vi.fn(), lookup: vi.fn(), clear: vi.fn() };
    const bootstrap = vi.fn();
    await expect(
      bootstrapProductionSources({
        selected: ["mattpocock/skills"],
        deployment: {
          installationId: randomUUID(),
          composePath: "/release/compose.yaml",
          projectName: "skillwire-1234567890abcdef",
          databasePasswordFile: "/state/database-password",
          applicationPepperFile: "/state/application-pepper",
          runtimeSocketDirectory: "/runtime/skillwire",
          volumeName: "skillwire-1234567890abcdef_postgres_data",
          skillwireImage: `ghcr.io/lucenx9/skillwire@sha256:${"1".repeat(64)}`,
          postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
        },
        stateRoot,
        runtimeRoot,
        environment: { ...fixture.environment, DOCKER_CONTEXT: "remote" },
        token: "github_pat_source_only_read_token",
        signal: new AbortController().signal,
        credentialStore: store,
        bootstrap,
        resolveDockerEnvironment: () =>
          Promise.reject(new Error("A local Docker context is required")),
      }),
    ).rejects.toThrow(/local Docker context/i);
    expect(store.store).not.toHaveBeenCalled();
    expect(store.lookup).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("persists a cancellation-safe source boundary and resumes without duplicating the credential", async () => {
    fixture = await createOnboardingEnvironment();
    const stateRoot = resolve(fixture.xdgStateHome, "skillwire");
    const runtimeRoot = resolve(fixture.runtimeRoot, "skillwire");
    await Promise.all([
      mkdir(stateRoot, { recursive: true, mode: 0o700 }),
      mkdir(runtimeRoot, { recursive: true, mode: 0o700 }),
    ]);
    const installationId = randomUUID();
    const credentialReferenceId = randomUUID();
    await seedOwnership(stateRoot, installationId);
    const store = {
      store: vi.fn().mockResolvedValue({
        reference: `secret-service:github:${credentialReferenceId}`,
        referenceId: credentialReferenceId,
      }),
      lookup: vi.fn().mockResolvedValue("github_pat_source_only_read_token"),
      clear: vi.fn(),
    };
    const controller = new AbortController();
    const bootstrap = vi
      .fn()
      .mockResolvedValueOnce({
        sourceId: randomUUID(),
        classifications: ["curated"],
        created: true,
      })
      .mockImplementationOnce(() => {
        controller.abort();
        return Promise.reject(new Error("source synchronization cancelled"));
      });
    const base = {
      selected: ["mattpocock/skills", "obra/superpowers"] as const,
      deployment: {
        installationId,
        composePath: "/release/compose.yaml",
        projectName: "skillwire-1234567890abcdef",
        databasePasswordFile: "/state/database-password",
        applicationPepperFile: "/state/application-pepper",
        runtimeSocketDirectory: "/runtime/skillwire",
        volumeName: "skillwire-1234567890abcdef_postgres_data",
        skillwireImage: `ghcr.io/lucenx9/skillwire@sha256:${"1".repeat(64)}`,
        postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
      },
      stateRoot,
      runtimeRoot,
      environment: fixture.environment,
      token: "github_pat_source_only_read_token",
      credentialStore: store,
      bootstrap,
      resolveDockerEnvironment: (environment: NodeJS.ProcessEnv) =>
        Promise.resolve(environment),
    };

    await expect(
      bootstrapProductionSources({ ...base, signal: controller.signal }),
    ).rejects.toThrow(/cancel/i);
    const persisted = await readProtectedSourceChoices(
      resolve(stateRoot, "source-choices.json"),
    );
    expect(persisted?.choices).toMatchObject([
      { source: "mattpocock/skills", syncState: "eligible" },
      {
        source: "obra/superpowers",
        syncState: "failed",
        credentialReferenceId,
      },
    ]);

    bootstrap.mockReset().mockResolvedValue({
      sourceId: randomUUID(),
      classifications: ["quarantined"],
      created: true,
    });
    const resumed = await bootstrapProductionSources({
      ...base,
      token: undefined,
      signal: new AbortController().signal,
    });
    expect(resumed.choices).toMatchObject([
      { source: "mattpocock/skills", syncState: "eligible" },
      { source: "obra/superpowers", syncState: "quarantined" },
    ]);
    expect(store.store).toHaveBeenCalledTimes(1);
    expect(store.lookup).toHaveBeenCalledTimes(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });
});
