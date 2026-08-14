/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production recovery interfaces. */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  journalNeedsRecovery,
  recoverOperation,
} from "../../../src/onboarding/application/recovery.js";
import { createProductionLifecycleOperations } from "../../../src/onboarding/application/production-lifecycle.js";
import { OperationJournal } from "../../../src/onboarding/domain/operation-journal.js";
import { createOwnershipLedger } from "../../../src/onboarding/domain/ownership.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

describe("observation-based interruption recovery", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it.each([
    ["intent", "safe-retry"],
    ["effect", "resume"],
    ["verify", "resume"],
    ["compensate", "resume"],
    ["commit", "complete"],
  ] as const)(
    "recovers interruption after %s without inventing completion",
    async (boundary, expected) => {
      fixture = await createOnboardingEnvironment();
      const root = resolve(fixture.root, "journals");
      const journal = await OperationJournal.create(
        root,
        randomUUID(),
        "repair",
      );
      await journal.intent("owned-plugin", { client: "codex" });
      if (boundary !== "intent")
        await journal.effect("owned-plugin", { completion: "recorded" });
      if (["verify", "compensate", "commit"].includes(boundary))
        await journal.verify("owned-plugin", { identityMatches: true });
      if (boundary === "compensate")
        await journal.compensate("owned-plugin", {
          completion: "recorded",
        });
      if (boundary === "commit") await journal.commit({ status: "success" });
      const compensate = vi.fn(async () => undefined);

      const result = await recoverOperation({
        journal,
        signal: new AbortController().signal,
        observe: async () => "matching",
        compensate,
      });

      expect(result.disposition).toBe(expected);
      expect(result.disposition === "complete" ? result.changed : false).toBe(
        false,
      );
      expect(compensate).not.toHaveBeenCalled();
    },
  );

  it("blocks ambiguous effects and compensates only a proven mismatching owned effect", async () => {
    fixture = await createOnboardingEnvironment();
    const root = resolve(fixture.root, "journals");
    const ambiguous = await OperationJournal.create(
      root,
      randomUUID(),
      "uninstall",
    );
    await ambiguous.intent("client-codex-plugin", { client: "codex" });
    await ambiguous.effect("client-codex-plugin", { completion: "recorded" });
    const compensate = vi.fn(async () => undefined);
    await expect(
      recoverOperation({
        journal: ambiguous,
        signal: new AbortController().signal,
        observe: async () => "ambiguous",
        compensate,
      }),
    ).resolves.toMatchObject({ disposition: "recovery-required" });
    expect(compensate).not.toHaveBeenCalled();

    const mismatching = await OperationJournal.create(
      root,
      randomUUID(),
      "repair",
    );
    await mismatching.intent("owned-plugin", { client: "claude" });
    await mismatching.effect("owned-plugin", { completion: "recorded" });
    await recoverOperation({
      journal: mismatching,
      signal: new AbortController().signal,
      observe: async () => "owned-mismatch",
      compensate,
    });
    expect(compensate).toHaveBeenCalledWith("owned-plugin");
  });

  it("re-observes and clears a journaled unproven compensation boundary", async () => {
    fixture = await createOnboardingEnvironment();
    const root = resolve(fixture.root, "journals");
    const journal = await OperationJournal.create(
      root,
      randomUUID(),
      "uninstall",
    );
    await journal.intent("client-codex-mcp", { client: "codex" });
    await journal.compensate("client-codex-mcp", {
      completion: "unproven",
      recoveryRequired: true,
    });

    await expect(
      recoverOperation({
        journal,
        signal: new AbortController().signal,
        observe: async () => "absent",
        compensate: vi.fn(),
      }),
    ).resolves.toMatchObject({ disposition: "safe-retry", changed: true });
    expect(journal.hasUnprovenEffect()).toBe(false);
    expect(journal.entries.at(-1)).toMatchObject({
      phase: "commit",
      detail: { status: "recovered" },
    });
  });

  it("can finish a recovery-required cancellation after fresh observation", async () => {
    fixture = await createOnboardingEnvironment();
    const root = resolve(fixture.root, "journals");
    const journal = await OperationJournal.create(
      root,
      randomUUID(),
      "uninstall",
    );
    await journal.intent("client-codex-mcp", { client: "codex" });
    await journal.compensate("client-codex-mcp", {
      completion: "unproven",
      recoveryRequired: true,
    });
    await journal.cancel({ status: "recovery-required" });

    await expect(
      recoverOperation({
        journal,
        signal: new AbortController().signal,
        observe: async () => "absent",
        compensate: vi.fn(),
      }),
    ).resolves.toMatchObject({ disposition: "safe-retry", changed: true });
    expect(journal.hasUnprovenEffect()).toBe(false);
    expect(journal.entries.at(-1)).toMatchObject({
      phase: "commit",
      detail: { status: "recovered" },
    });
  });

  it("does not mistake a recovery-required cancellation for a terminal safe state", async () => {
    fixture = await createOnboardingEnvironment();
    const root = resolve(fixture.root, "journals");
    const journal = await OperationJournal.create(
      root,
      randomUUID(),
      "upgrade",
    );
    await journal.intent("upgrade-migration", { schema: 10 });
    await journal.compensate("upgrade-migration", {
      completion: "unproven",
      recoveryRequired: true,
    });
    await journal.cancel({ status: "recovery-required" });

    expect(journalNeedsRecovery(journal.entries)).toBe(true);
    await expect(
      recoverOperation({
        journal,
        signal: new AbortController().signal,
        observe: async () => "ambiguous",
        compensate: vi.fn(),
      }),
    ).resolves.toMatchObject({ disposition: "recovery-required" });
  });

  it("returns a stable recovery result when production repair finds an ambiguous interrupted effect", async () => {
    fixture = await createOnboardingEnvironment();
    const stateRoot = resolve(fixture.xdgStateHome, "skillwire");
    const installationId = randomUUID();
    await mkdir(resolve(stateRoot, "operations"), {
      recursive: true,
      mode: 0o700,
    });
    const writeProtected = async (name: string, value: unknown) =>
      writeFile(resolve(stateRoot, name), `${JSON.stringify(value)}\n`, {
        mode: 0o600,
      });
    const timestamp = "2026-08-14T08:00:00.000Z";
    await writeProtected("installation.json", {
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
    });
    await writeProtected("deployment.json", {
      schemaVersion: "skillwire.deployment/v1",
      installationId,
      releaseRoot: resolve(fixture.root, "release"),
      composePath: resolve(fixture.root, "release/compose.yaml"),
      skillwireImage: `skillwire@sha256:${"a".repeat(64)}`,
      postgresImage: `postgres@sha256:${"b".repeat(64)}`,
      databasePasswordFile: resolve(fixture.root, "database-password"),
      applicationPepperFile: resolve(fixture.root, "application-pepper"),
      runtimeSocketDirectory: resolve(fixture.runtimeRoot, "skillwire"),
      socketPath: resolve(fixture.runtimeRoot, "skillwire/mcp.sock"),
      projectName: fixture.composeProject,
      volumeName: fixture.postgresVolume,
    });
    await writeProtected(
      "ownership.json",
      createOwnershipLedger(installationId).record,
    );
    const interrupted = await OperationJournal.create(
      resolve(stateRoot, "operations"),
      randomUUID(),
      "upgrade",
    );
    await interrupted.intent("upgrade-migration", { schema: 10 });
    await interrupted.effect("upgrade-migration", { completion: "recorded" });

    const repair = createProductionLifecycleOperations(
      fixture.environment,
    ).repair;
    expect(repair).toBeDefined();
    const preview = await repair?.(
      {
        route: "repair",
        output: "json",
        previewOnly: true,
        stateRoot,
      },
      new AbortController().signal,
    );

    await expect(
      repair?.(
        {
          route: "repair",
          output: "json",
          previewOnly: false,
          confirmPreview: preview?.previewHash ?? undefined,
          stateRoot,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      status: "recovery-required",
      exitClass: "rollback-required",
      changed: false,
      findings: [{ code: "JOURNAL_RECOVERY_REQUIRED" }],
    });
  });
});
