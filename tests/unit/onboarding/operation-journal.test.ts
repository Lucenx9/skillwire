import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import {
  currentProcessIdentity,
  InstallationLock,
  JournaledOperationFailure,
  OperationJournal,
} from "../../../src/onboarding/domain/operation-journal.js";

describe("operation journal and installation lock", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("durably records intent before effect, verification, compensation, and commit", async () => {
    fixture = await createOnboardingEnvironment();
    const journal = await OperationJournal.create(
      resolve(fixture.root, "journals"),
      randomUUID(),
      "setup",
    );
    await journal.intent("create-secret", { component: "database-password" });
    await journal.effect("create-secret", { changed: true });
    await journal.verify("create-secret", { mode: "0600" });
    await journal.compensate("create-secret", { removed: true });
    await journal.commit({ status: "incomplete" });
    expect(journal.entries.map(({ phase }) => phase)).toEqual([
      "intent",
      "effect",
      "verify",
      "compensate",
      "commit",
    ]);
    const reopened = await OperationJournal.open(
      resolve(fixture.root, "journals"),
      journal.operationId,
      "setup",
    );
    expect(reopened.entries).toEqual(journal.entries);
    await expect(reopened.commit({ status: "success" })).rejects.toThrow(
      /terminal|success|verification/i,
    );
  });

  it("records every external effect boundary and stops after cancellation", async () => {
    fixture = await createOnboardingEnvironment();
    const journal = await OperationJournal.create(
      resolve(fixture.root, "journals"),
      randomUUID(),
      "setup",
    );
    const controller = new AbortController();
    await expect(
      journal.runEffect({
        step: "deployment",
        intent: { component: "compose" },
        signal: controller.signal,
        action: async () => {
          await Promise.resolve();
          controller.abort();
          throw new Error("cancelled subprocess");
        },
        verification: () => ({ ready: true }),
      }),
    ).rejects.toMatchObject({ effectMayHaveBegun: true });
    expect(journal.entries.map(({ phase }) => phase)).toEqual([
      "intent",
      "compensate",
    ]);
    await journal.cancel({ status: "recovery-required" });
    expect(journal.entries.at(-1)?.phase).toBe("cancel");
  });

  it("preserves a proven mutation-not-started failure without inventing recovery", async () => {
    fixture = await createOnboardingEnvironment();
    const journal = await OperationJournal.create(
      resolve(fixture.root, "journals"),
      randomUUID(),
      "setup",
    );
    const notStarted = new Error("preflight conflict");

    await expect(
      journal.runEffect({
        step: "client-claude-mcp-profile",
        intent: { client: "claude" },
        signal: new AbortController().signal,
        action: () => Promise.reject(notStarted),
        effectNotStarted: (error) => error === notStarted,
        verification: () => ({ installed: true }),
      }),
    ).rejects.toBe(notStarted);
    expect(journal.entries.map(({ phase }) => phase)).toEqual([
      "intent",
      "compensate",
    ]);
    expect(journal.entries.at(-1)?.detail).toEqual({
      completion: "not-started",
      recoveryRequired: false,
    });
    expect(journal.hasUnprovenEffect()).toBe(false);
  });

  it("wraps only unresolved journaled mutations for the CLI recovery envelope", async () => {
    fixture = await createOnboardingEnvironment();
    const journal = await OperationJournal.create(
      resolve(fixture.root, "journals"),
      randomUUID(),
      "uninstall",
    );
    const failure = new Error("post-effect publication failed");
    await journal.intent("uninstall", { confirmed: true });
    expect(journal.failure(failure)).toBe(failure);

    await journal.runEffect({
      step: "uninstall-owned-client",
      intent: { client: "codex" },
      signal: new AbortController().signal,
      action: () => Promise.resolve(),
      verification: () => ({ removed: true }),
    });
    expect(journal.failure(failure)).toBeInstanceOf(JournaledOperationFailure);

    await journal.compensate("uninstall-owned-client", {
      completion: "reverted",
      recoveryRequired: false,
    });
    expect(journal.failure(failure)).toBe(failure);
  });

  it("persists the required setup effect inventory as intent/effect/verify triplets", async () => {
    fixture = await createOnboardingEnvironment();
    const journal = await OperationJournal.create(
      resolve(fixture.root, "journals"),
      randomUUID(),
      "setup",
    );
    const signal = new AbortController().signal;
    const steps = [
      "deployment",
      "service-secrets",
      "account-create",
      "client-codex-key",
      "client-codex-credential",
      "client-codex-mcp-profile",
      "client-codex-marketplace-install",
      "client-codex-plugin-install",
      "client-claude-plugin-enable",
      "final-state-publication",
    ];
    for (const step of steps)
      await journal.runEffect({
        step,
        intent: { component: step },
        signal,
        action: () => Promise.resolve(step),
        verification: () => ({ completed: true }),
      });
    await journal.commit({ status: "success" });
    for (const step of steps)
      expect(
        journal.entries
          .filter((entry) => entry.step === step)
          .map(({ phase }) => phase),
      ).toEqual(["intent", "effect", "verify"]);
  });

  it("rejects false success and reclaims only a proven stale process identity", async () => {
    fixture = await createOnboardingEnvironment();
    const lockRoot = resolve(fixture.root, "locks");
    const identity = await currentProcessIdentity();
    const lock = await InstallationLock.acquire(
      lockRoot,
      "installation",
      identity,
    );
    await expect(
      InstallationLock.acquire(lockRoot, "installation", identity),
    ).rejects.toThrow(/locked/);
    await lock.release();
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(lockRoot, "installation.lock"),
      JSON.stringify({
        pid: process.pid,
        bootId: identity.bootId,
        processStart: String(Number(identity.processStart) + 1),
      }),
      { mode: 0o600 },
    );
    const reclaimed = await InstallationLock.acquire(
      lockRoot,
      "installation",
      identity,
    );
    await reclaimed.release();
  });

  it("uses a persistent kernel lock so two contenders cannot unlink each other's ownership", async () => {
    fixture = await createOnboardingEnvironment();
    const lockRoot = resolve(fixture.root, "locks");
    const identity = await currentProcessIdentity();
    const attempts = await Promise.allSettled([
      InstallationLock.acquire(lockRoot, "installation", identity),
      InstallationLock.acquire(lockRoot, "installation", identity),
    ]);
    const acquired = attempts.filter(
      (entry): entry is PromiseFulfilledResult<InstallationLock> =>
        entry.status === "fulfilled",
    );
    expect(acquired).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    await acquired[0]?.value.release();
    expect((await stat(resolve(lockRoot, "installation.lock"))).isFile()).toBe(
      true,
    );
    const next = await InstallationLock.acquire(
      lockRoot,
      "installation",
      identity,
    );
    await next.release();
  });
});
