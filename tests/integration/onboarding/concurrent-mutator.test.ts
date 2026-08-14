import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  currentProcessIdentity,
  InstallationLock,
} from "../../../src/onboarding/domain/operation-journal.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

describe("single installation mutator", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("allows exactly one live holder and permits a later proven successor", async () => {
    fixture = await createOnboardingEnvironment();
    const root = resolve(fixture.runtimeRoot, "locks");
    const identity = await currentProcessIdentity();
    const outcomes = await Promise.allSettled([
      InstallationLock.acquire(root, "installation", identity),
      InstallationLock.acquire(root, "installation", identity),
    ]);
    const holders = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<InstallationLock> =>
        outcome.status === "fulfilled",
    );
    expect(holders).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    await holders[0]?.value.release();
    const successor = await InstallationLock.acquire(
      root,
      "installation",
      identity,
    );
    await successor.release();
  });

  it("does not trust stale metadata when the kernel lock is no longer held", async () => {
    fixture = await createOnboardingEnvironment();
    const root = resolve(fixture.runtimeRoot, "stale-locks");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(root, "installation.lock"),
      `${JSON.stringify({
        pid: 999_999_999,
        bootId: "00000000-0000-4000-8000-000000000001",
        processStart: "1",
      })}\n`,
      { mode: 0o600 },
    );
    const holder = await InstallationLock.acquire(
      root,
      "installation",
      await currentProcessIdentity(),
    );
    await holder.release();
  });
});
