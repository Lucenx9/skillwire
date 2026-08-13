import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import {
  currentProcessIdentity,
  InstallationLock,
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
});
