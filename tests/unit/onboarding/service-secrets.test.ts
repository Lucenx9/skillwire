import {
  chmod,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { ensureServiceSecrets } from "../../../src/onboarding/secrets/service-secrets.js";

describe("service-secret lifecycle", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("creates independent 256-bit values exclusively with 0700/0600 and reuses bytes", async () => {
    fixture = await createOnboardingEnvironment();
    const installationRoot = resolve(
      fixture.stateRoot,
      "installations/00000000-0000-4000-8000-000000000001",
    );
    const first = await ensureServiceSecrets(
      installationRoot,
      fixture.stateRoot,
    );
    const directory = resolve(installationRoot, "secrets");
    const databasePath = resolve(directory, "database-password");
    const pepperPath = resolve(directory, "application-pepper");
    const before = await Promise.all([
      readFile(databasePath),
      readFile(pepperPath),
    ]);
    expect(before[0]).not.toEqual(before[1]);
    expect(before[0].byteLength).toBeGreaterThanOrEqual(43);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(databasePath)).mode & 0o777).toBe(0o600);
    expect(first.map(({ identitySha256 }) => identitySha256)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^[0-9a-f]{64}$/),
        expect.stringMatching(/^[0-9a-f]{64}$/),
      ]),
    );
    const second = await ensureServiceSecrets(
      installationRoot,
      fixture.stateRoot,
    );
    const after = await Promise.all([
      readFile(databasePath),
      readFile(pepperPath),
    ]);
    expect(after).toEqual(before);
    expect(second.map(({ identitySha256 }) => identitySha256)).toEqual(
      first.map(({ identitySha256 }) => identitySha256),
    );
    expect(second.every(({ state }) => state === "reused")).toBe(true);
    expect(JSON.stringify(second)).not.toContain(before[0].toString("utf8"));
  });

  it("rejects links and unsafe modes without rotating or disclosing values", async () => {
    fixture = await createOnboardingEnvironment();
    const installationRoot = resolve(
      fixture.stateRoot,
      "installations/00000000-0000-4000-8000-000000000002",
    );
    const secretsRoot = resolve(installationRoot, "secrets");
    await mkdir(secretsRoot, { recursive: true, mode: 0o700 });
    const outside = resolve(fixture.root, "outside-secret");
    await writeFile(outside, "x".repeat(43), { mode: 0o600 });
    await symlink(outside, resolve(secretsRoot, "database-password"));
    await expect(
      ensureServiceSecrets(installationRoot, fixture.stateRoot),
    ).rejects.toThrow();
    await writeFile(
      resolve(secretsRoot, "application-pepper"),
      "y".repeat(43),
      { mode: 0o600 },
    );
    await chmod(resolve(secretsRoot, "application-pepper"), 0o644);
    await expect(
      ensureServiceSecrets(installationRoot, fixture.stateRoot),
    ).rejects.toThrow();
  });
});
