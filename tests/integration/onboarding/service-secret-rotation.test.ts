/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-confusing-void-expression -- Async fakes mirror production rotation interfaces. */
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  previewServiceSecretRotation,
  rotateServiceSecret,
} from "../../../src/onboarding/application/service-secret-rotation.js";
import { createProductionLifecycleOperations } from "../../../src/onboarding/application/production-lifecycle.js";
import { ensureServiceSecrets } from "../../../src/onboarding/secrets/service-secrets.js";
import { snapshotTree } from "../../helpers/filesystem-snapshot.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

describe("explicit service-secret rotation", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it.each(["database-password", "application-pepper"] as const)(
    "rotates %s independently, retains the old file, and commits only after readiness",
    async (kind) => {
      fixture = await createOnboardingEnvironment();
      const installationId = randomUUID();
      const installationRoot = resolve(
        fixture.stateRoot,
        "installations",
        installationId,
      );
      const references = await ensureServiceSecrets(
        installationRoot,
        fixture.stateRoot,
      );
      const reference = references.find((entry) => entry.kind === kind);
      if (reference === undefined) throw new Error("Missing service secret");
      const currentPath = resolve(installationRoot, "secrets", kind);
      const before = await readFile(currentPath, "utf8");
      const siblingKind =
        kind === "database-password"
          ? "application-pepper"
          : "database-password";
      const siblingPath = resolve(installationRoot, "secrets", siblingKind);
      const siblingBefore = await readFile(siblingPath, "utf8");
      const preview = previewServiceSecretRotation({
        installationId,
        kind,
        currentIdentitySha256: reference.identitySha256,
      });
      const events: string[] = [];

      const result = await rotateServiceSecret({
        installationRoot,
        stateRoot: fixture.stateRoot,
        kind,
        confirmation: preview.previewHash,
        preview,
        signal: new AbortController().signal,
        apply: async (path) => {
          events.push(`apply:${path}`);
        },
        readiness: async () => {
          events.push("ready");
        },
        publish: async () => {
          events.push("publish");
        },
      });

      const after = await readFile(currentPath, "utf8");
      expect(after).not.toBe(before);
      expect(await readFile(result.retainedPath, "utf8")).toBe(before);
      expect(await readFile(siblingPath, "utf8")).toBe(siblingBefore);
      expect((await lstat(currentPath)).mode & 0o777).toBe(0o600);
      expect(events.at(-1)).toBe("publish");
      expect(JSON.stringify(result)).not.toContain(before);
      expect(JSON.stringify(result)).not.toContain(after);
    },
  );

  it("blocks application-pepper rotation before mutation when the runtime has no safe overlap support", async () => {
    fixture = await createOnboardingEnvironment();
    const operations = createProductionLifecycleOperations(fixture.environment);
    const before = await snapshotTree(fixture.root);

    await expect(
      operations["maintenance:rotate-service-secret"]?.(
        {
          route: "maintenance:rotate-service-secret",
          output: "json",
          previewOnly: true,
          serviceSecret: "application-pepper",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/overlap|existing client keys|unsupported/i);
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  it("rejects current-secret identity drift before any rotation effect", async () => {
    fixture = await createOnboardingEnvironment();
    const installationId = randomUUID();
    const installationRoot = resolve(
      fixture.stateRoot,
      "installations",
      installationId,
    );
    const references = await ensureServiceSecrets(
      installationRoot,
      fixture.stateRoot,
    );
    const reference = references.find(
      ({ kind }) => kind === "database-password",
    );
    if (reference === undefined) throw new Error("Missing database secret");
    const currentPath = resolve(installationRoot, "secrets/database-password");
    const driftedValue = "D".repeat(43);
    await writeFile(currentPath, driftedValue, "ascii");
    const beforeNames = await readdir(resolve(installationRoot, "secrets"));
    const preview = previewServiceSecretRotation({
      installationId,
      kind: "database-password",
      currentIdentitySha256: reference.identitySha256,
    });
    const apply = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);

    await expect(
      rotateServiceSecret({
        installationRoot,
        stateRoot: fixture.stateRoot,
        kind: "database-password",
        confirmation: preview.previewHash,
        preview,
        signal: new AbortController().signal,
        apply,
        readiness: async () => undefined,
        publish,
      }),
    ).rejects.toThrow(/identity|drift|changed/i);

    expect(apply).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await readFile(currentPath, "ascii")).toBe(driftedValue);
    expect(await readdir(resolve(installationRoot, "secrets"))).toEqual(
      beforeNames,
    );
  });

  it("preserves a pre-existing candidate residue when exclusive creation fails", async () => {
    fixture = await createOnboardingEnvironment();
    const installationId = randomUUID();
    const installationRoot = resolve(
      fixture.stateRoot,
      "installations",
      installationId,
    );
    const references = await ensureServiceSecrets(
      installationRoot,
      fixture.stateRoot,
    );
    const reference = references.find(
      ({ kind }) => kind === "database-password",
    );
    if (reference === undefined) throw new Error("Missing database secret");
    const currentPath = resolve(installationRoot, "secrets/database-password");
    const currentBefore = await readFile(currentPath, "ascii");
    const preview = previewServiceSecretRotation({
      installationId,
      kind: "database-password",
      currentIdentitySha256: reference.identitySha256,
    });
    const candidatePath = resolve(
      installationRoot,
      "secrets",
      `database-password.candidate-${preview.operationId}`,
    );
    const residue = "C".repeat(43);
    await writeFile(candidatePath, residue, { encoding: "ascii", mode: 0o600 });
    const apply = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);

    await expect(
      rotateServiceSecret({
        installationRoot,
        stateRoot: fixture.stateRoot,
        kind: "database-password",
        confirmation: preview.previewHash,
        preview,
        signal: new AbortController().signal,
        apply,
        readiness: async () => undefined,
        publish,
      }),
    ).rejects.toThrow(/exist|candidate|rotation/i);

    expect(await readFile(candidatePath, "ascii")).toBe(residue);
    expect(await readFile(currentPath, "ascii")).toBe(currentBefore);
    expect(apply).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("fails closed without replacing a pre-existing retained target", async () => {
    fixture = await createOnboardingEnvironment();
    const installationId = randomUUID();
    const installationRoot = resolve(
      fixture.stateRoot,
      "installations",
      installationId,
    );
    const references = await ensureServiceSecrets(
      installationRoot,
      fixture.stateRoot,
    );
    const reference = references.find(
      ({ kind }) => kind === "application-pepper",
    );
    if (reference === undefined) throw new Error("Missing application secret");
    const currentPath = resolve(installationRoot, "secrets/application-pepper");
    const currentBefore = await readFile(currentPath, "ascii");
    const preview = previewServiceSecretRotation({
      installationId,
      kind: "application-pepper",
      currentIdentitySha256: reference.identitySha256,
    });
    const retainedPath = resolve(
      installationRoot,
      "secrets",
      `application-pepper.retained-${preview.operationId}`,
    );
    const retainedBefore = "R".repeat(43);
    await writeFile(retainedPath, retainedBefore, {
      encoding: "ascii",
      mode: 0o600,
    });
    const apply = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);

    await expect(
      rotateServiceSecret({
        installationRoot,
        stateRoot: fixture.stateRoot,
        kind: "application-pepper",
        confirmation: preview.previewHash,
        preview,
        signal: new AbortController().signal,
        apply,
        readiness: async () => undefined,
        publish,
      }),
    ).rejects.toThrow(/exist|retained|rotation/i);

    expect(await readFile(retainedPath, "ascii")).toBe(retainedBefore);
    expect(await readFile(currentPath, "ascii")).toBe(currentBefore);
    expect(apply).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("rolls application configuration back at a failed readiness boundary", async () => {
    fixture = await createOnboardingEnvironment();
    const installationId = randomUUID();
    const installationRoot = resolve(
      fixture.stateRoot,
      "installations",
      installationId,
    );
    const references = await ensureServiceSecrets(
      installationRoot,
      fixture.stateRoot,
    );
    const reference = references.find(
      ({ kind }) => kind === "database-password",
    );
    if (reference === undefined) throw new Error("Missing database secret");
    const currentPath = resolve(installationRoot, "secrets/database-password");
    const before = await readFile(currentPath, "utf8");
    const preview = previewServiceSecretRotation({
      installationId,
      kind: "database-password",
      currentIdentitySha256: reference.identitySha256,
    });
    const rollback = vi.fn(async () => undefined);

    await expect(
      rotateServiceSecret({
        installationRoot,
        stateRoot: fixture.stateRoot,
        kind: "database-password",
        confirmation: preview.previewHash,
        preview,
        signal: new AbortController().signal,
        apply: async () => undefined,
        readiness: async () => {
          throw new Error("not ready");
        },
        publish: async () => undefined,
        rollback,
      }),
    ).rejects.toThrow(/ready|readiness/i);
    expect(await readFile(currentPath, "utf8")).toBe(before);
    expect(rollback).toHaveBeenCalledWith(currentPath);
    expect(
      (await readdir(resolve(installationRoot, "secrets"))).some((name) =>
        name.includes("candidate"),
      ),
    ).toBe(false);
  });

  it.each([
    "apply-candidate",
    "candidate-readiness",
    "apply-current",
    "current-readiness",
    "publish",
  ] as const)("restores the old value after a %s failure", async (boundary) => {
    fixture = await createOnboardingEnvironment();
    const installationId = randomUUID();
    const installationRoot = resolve(
      fixture.stateRoot,
      "installations",
      installationId,
    );
    const references = await ensureServiceSecrets(
      installationRoot,
      fixture.stateRoot,
    );
    const reference = references.find(
      ({ kind: secretKind }) => secretKind === "application-pepper",
    );
    if (reference === undefined) throw new Error("Missing application secret");
    const currentPath = resolve(installationRoot, "secrets/application-pepper");
    const before = await readFile(currentPath, "utf8");
    const preview = previewServiceSecretRotation({
      installationId,
      kind: "application-pepper",
      currentIdentitySha256: reference.identitySha256,
    });
    let applyCount = 0;
    let readinessCount = 0;
    const fail = (name: typeof boundary): void => {
      if (boundary === name) throw new Error(`${name} failed`);
    };
    await expect(
      rotateServiceSecret({
        installationRoot,
        stateRoot: fixture.stateRoot,
        kind: "application-pepper",
        confirmation: preview.previewHash,
        preview,
        signal: new AbortController().signal,
        apply: async () => {
          applyCount += 1;
          fail(applyCount === 1 ? "apply-candidate" : "apply-current");
        },
        readiness: async () => {
          readinessCount += 1;
          fail(
            readinessCount === 1 ? "candidate-readiness" : "current-readiness",
          );
        },
        publish: async () => fail("publish"),
      }),
    ).rejects.toThrow(/rotation|readiness|failed/i);
    expect(await readFile(currentPath, "utf8")).toBe(before);
    expect(
      (await readdir(resolve(installationRoot, "secrets"))).some((name) =>
        /candidate|retained/.test(name),
      ),
    ).toBe(false);
  });
});
