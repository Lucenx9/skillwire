import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type * as ReleaseVerifierModule from "../../../src/onboarding/adapters/filesystem/release-verifier.js";
import { verifySignedReleaseEnvelope } from "../../../src/onboarding/adapters/filesystem/release-verifier.js";

vi.mock(
  "../../../src/onboarding/adapters/filesystem/release-verifier.js",
  async (importOriginal) => {
    const original = await importOriginal<typeof ReleaseVerifierModule>();
    return {
      ...original,
      verifySignedReleaseEnvelope: vi.fn(original.verifySignedReleaseEnvelope),
    };
  },
);

import {
  cleanupQuickstartDeployment,
  quickstartCleanupPlan,
  runQuickstartPostSetupChecks,
  validateSelfHostedQuickstart,
} from "../../../scripts/validate-self-hosted-quickstart.js";
import { clientComponentIdentity } from "../../../src/onboarding/adapters/clients/client-state.js";
import {
  createOwnershipLedger,
  recordOwnedAsset,
} from "../../../src/onboarding/domain/ownership.js";
import { createFakeExecutables } from "../../helpers/onboarding-executables.js";
import { createOnboardingEnvironment } from "../../helpers/onboarding-environment.js";
import {
  bundleV03Fixture,
  canonicalJson,
  FIXTURE_ARCHIVE,
  releaseManifestFixture,
  sha256,
  trustPolicyFixture,
  trustedRootFixture,
} from "../../helpers/self-hosted-release-fixtures.js";

const INSTALLATION_ID = "01234567-89ab-4def-8123-456789abcdef";
const PROJECT = "skillwire-0123456789ab4def8123456789abcdef";
const VOLUME = `${PROJECT}_postgres_data`;

function deployment(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: "skillwire.deployment/v1",
    installationId: INSTALLATION_ID,
    composePath: "/tmp/disposable/release/compose.yaml",
    projectName: PROJECT,
    volumeName: VOLUME,
    skillwireImage: `ghcr.io/lucenx9/skillwire@sha256:${"1".repeat(64)}`,
    postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
    databasePasswordFile: "/tmp/disposable/database-password",
    applicationPepperFile: "/tmp/disposable/application-pepper",
    runtimeSocketDirectory: "/tmp/disposable/runtime",
    ...overrides,
  };
}

function ownership(overrides: { installationId?: string } = {}): unknown {
  let ledger = createOwnershipLedger(
    overrides.installationId ?? INSTALLATION_ID,
  );
  for (const asset of [
    {
      kind: "compose-project" as const,
      locator: PROJECT,
      identity: clientComponentIdentity({ projectName: PROJECT }),
      retention: "remove-on-uninstall" as const,
    },
    {
      kind: "container" as const,
      locator: `${PROJECT}:skillwire`,
      identity: clientComponentIdentity({
        projectName: PROJECT,
        service: "skillwire",
      }),
      retention: "remove-on-uninstall" as const,
    },
    {
      kind: "container" as const,
      locator: `${PROJECT}:postgres`,
      identity: clientComponentIdentity({
        projectName: PROJECT,
        service: "postgres",
      }),
      retention: "remove-on-uninstall" as const,
    },
    {
      kind: "volume" as const,
      locator: VOLUME,
      identity: clientComponentIdentity({ volumeName: VOLUME }),
      retention: "retain-by-default" as const,
    },
  ]) {
    ledger = recordOwnedAsset(ledger, {
      assetId: randomUUID(),
      kind: asset.kind,
      client: null,
      locator: asset.locator,
      expectedIdentitySha256: asset.identity,
      createdByOperation: randomUUID(),
      retention: asset.retention,
      disposition: "present",
    });
  }
  return ledger.record;
}

describe("disposable quickstart cleanup boundary", () => {
  it("binds the real Compose fixture cleanup to recorded ownership instead of daemon-wide inventory differences", async () => {
    const source = await readFile(
      "tests/integration/onboarding/production-setup.test.ts",
      "utf8",
    );
    expect(source).toContain("cleanupQuickstartDeployment");
    expect(source).not.toContain("dockerInventory");
    expect(source).not.toContain("baselineContainers");
    expect(source).not.toContain("baselineVolumes");
  });

  it("names one exact Compose project and its matching volume", () => {
    const plan = quickstartCleanupPlan(deployment(), ownership());
    expect(plan.args).toEqual([
      "compose",
      "--project-name",
      PROJECT,
      "--file",
      "/tmp/disposable/release/compose.yaml",
      "down",
      "--volumes",
    ]);
    expect(plan.deployment.volumeName).toBe(VOLUME);
  });

  it.each([
    { projectName: "skillwire-*" },
    { projectName: "other", volumeName: "other_postgres_data" },
    { volumeName: "skillwire-ffffffffffffffff_postgres_data" },
    { composePath: "relative/compose.yaml" },
  ])("rejects unresolved or mismatching destructive targets", (shape) => {
    expect(() =>
      quickstartCleanupPlan(deployment(shape), ownership()),
    ).toThrow();
  });

  it("rejects cleanup without an installation-bound ownership record", () => {
    expect(() =>
      quickstartCleanupPlan(
        deployment(),
        ownership({ installationId: randomUUID() }),
      ),
    ).toThrow(/ownership|installation/i);
  });

  it("executes only the validated project cleanup with a minimal environment", async () => {
    const calls: {
      args: readonly string[];
      environment: NodeJS.ProcessEnv | undefined;
    }[] = [];
    await cleanupQuickstartDeployment(
      deployment(),
      ownership(),
      {
        HOME: "/tmp/disposable/home",
        PATH: "/usr/bin:/bin",
        GH_TOKEN: "ambient-must-not-propagate",
      },
      (options) => {
        calls.push({ args: options.args, environment: options.environment });
        const joined = options.args.join(" ");
        if (joined.startsWith("container ls"))
          return Promise.resolve({
            code: 0,
            stdout: `${"a".repeat(64)}\n${"b".repeat(64)}\n`,
            stderr: "",
            durationMilliseconds: 1,
          });
        if (joined.includes(" ps ") && joined.endsWith(" skillwire"))
          return Promise.resolve({
            code: 0,
            stdout: `${"a".repeat(64)}\n`,
            stderr: "",
            durationMilliseconds: 1,
          });
        if (joined.includes(" ps ") && joined.endsWith(" postgres"))
          return Promise.resolve({
            code: 0,
            stdout: `${"b".repeat(64)}\n`,
            stderr: "",
            durationMilliseconds: 1,
          });
        if (
          joined.startsWith("container inspect") &&
          joined.includes("a".repeat(64))
        )
          return Promise.resolve({
            code: 0,
            stdout: `${PROJECT}|skillwire|ghcr.io/lucenx9/skillwire@sha256:${"1".repeat(64)}\n`,
            stderr: "",
            durationMilliseconds: 1,
          });
        if (joined.startsWith("container inspect"))
          return Promise.resolve({
            code: 0,
            stdout: `${PROJECT}|postgres|docker.io/library/postgres@sha256:${"2".repeat(64)}\n`,
            stderr: "",
            durationMilliseconds: 1,
          });
        if (joined.startsWith("volume inspect"))
          return Promise.resolve({
            code: 0,
            stdout: `${VOLUME}|${PROJECT}|postgres_data\n`,
            stderr: "",
            durationMilliseconds: 1,
          });
        return Promise.resolve({
          code: 0,
          stdout: "",
          stderr: "",
          durationMilliseconds: 1,
        });
      },
    );
    expect(calls.at(-1)?.args).toEqual(
      quickstartCleanupPlan(deployment(), ownership()).args,
    );
    expect(calls.at(-1)?.environment).toMatchObject({
      HOME: "/tmp/disposable/home",
      PATH: "/usr/bin:/bin",
      SKILLWIRE_COMPOSE_PROJECT: PROJECT,
      SKILLWIRE_POSTGRES_VOLUME: VOLUME,
    });
    expect(calls.at(-1)?.environment?.["GH_TOKEN"]).toBeUndefined();
    expect(
      calls.find(({ args }) => args[0] === "container" && args[1] === "ls")
        ?.args,
    ).toContain("--no-trunc");
  });

  it("runs exact cleanup even when a post-setup diagnostic fails", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    await expect(
      runQuickstartPostSetupChecks({
        launcher: "/tmp/disposable/bin/skillwire",
        environment: { PATH: "/usr/bin:/bin" },
        run: () => Promise.reject(new Error("doctor failed")),
        cleanup,
      }),
    ).rejects.toThrow(/doctor failed/);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("refuses an unrecorded container in the exact Compose namespace", async () => {
    const calls: string[][] = [];
    await expect(
      cleanupQuickstartDeployment(
        deployment(),
        ownership(),
        { PATH: "/usr/bin:/bin" },
        (options) => {
          calls.push([...options.args]);
          const joined = options.args.join(" ");
          if (joined.startsWith("container ls"))
            return Promise.resolve({
              code: 0,
              stdout: `${"c".repeat(64)}\n`,
              stderr: "",
              durationMilliseconds: 1,
            });
          if (joined.includes(" ps ") && joined.endsWith(" skillwire"))
            return Promise.resolve({
              code: 0,
              stdout: `${"a".repeat(64)}\n`,
              stderr: "",
              durationMilliseconds: 1,
            });
          if (joined.includes(" ps ") && joined.endsWith(" postgres"))
            return Promise.resolve({
              code: 0,
              stdout: `${"b".repeat(64)}\n`,
              stderr: "",
              durationMilliseconds: 1,
            });
          if (joined.startsWith("container inspect"))
            return Promise.resolve({
              code: 0,
              stdout: joined.includes("a".repeat(64))
                ? `${PROJECT}|skillwire|ghcr.io/lucenx9/skillwire@sha256:${"1".repeat(64)}\n`
                : joined.includes("b".repeat(64))
                  ? `${PROJECT}|postgres|docker.io/library/postgres@sha256:${"2".repeat(64)}\n`
                  : `${PROJECT}|unrecorded|attacker.example/image:latest\n`,
              stderr: "",
              durationMilliseconds: 1,
            });
          if (joined.startsWith("volume inspect"))
            return Promise.resolve({
              code: 0,
              stdout: `${VOLUME}|${PROJECT}|postgres_data\n`,
              stderr: "",
              durationMilliseconds: 1,
            });
          return Promise.resolve({
            code: 0,
            stdout: "",
            stderr: "",
            durationMilliseconds: 1,
          });
        },
      ),
    ).rejects.toThrow(/unrecorded|unexpected|ownership/i);
    expect(calls.some((args) => args.includes("down"))).toBe(false);
  });

  it("removes its private root when verified bytes fail after the signature boundary but before setup mutation", async () => {
    const fixture = await createOnboardingEnvironment();
    try {
      const binaries = await createFakeExecutables(fixture.root);
      await chmod(binaries.cosign, 0o700);
      const cosignBytes = await readFile(binaries.cosign);
      const trustedRootPath = resolve(fixture.root, "trusted-root.v1.json");
      const policyPath = resolve(
        fixture.root,
        "skillwire-trust-policy-v1.json",
      );
      const manifestPath = resolve(fixture.root, "release.json");
      const bundlePath = resolve(
        fixture.root,
        "skillwire-0.1.0-test.1-linux-amd64.release.sigstore.json",
      );
      const archivePath = resolve(
        fixture.root,
        "skillwire-0.1.0-test.1-linux-amd64.tar.zst",
      );
      const trustedRootBytes = canonicalJson(trustedRootFixture());
      const policy = trustPolicyFixture({
        trustedRoot: {
          path: "trusted-root.v1.json",
          sha256: sha256(trustedRootBytes),
          mediaType:
            "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
        },
        cosign: {
          version: "3.1.3",
          binaries: {
            amd64: createHash("sha256").update(cosignBytes).digest("hex"),
            arm64: "a".repeat(64),
          },
        },
      });
      const policyBytes = canonicalJson(policy);
      const manifest = releaseManifestFixture({
        trustPolicy: {
          path: "skillwire-trust-policy-v1.json",
          size: Buffer.byteLength(policyBytes),
          sha256: sha256(policyBytes),
        },
      });
      await Promise.all([
        writeFile(trustedRootPath, trustedRootBytes, { mode: 0o600 }),
        writeFile(policyPath, policyBytes, { mode: 0o600 }),
        writeFile(manifestPath, canonicalJson(manifest), { mode: 0o600 }),
        writeFile(bundlePath, canonicalJson(bundleV03Fixture(manifest)), {
          mode: 0o600,
        }),
        writeFile(archivePath, FIXTURE_ARCHIVE, { mode: 0o600 }),
      ]);
      vi.mocked(verifySignedReleaseEnvelope).mockResolvedValueOnce({
        releaseVersion: manifest.releaseVersion,
        releaseSequence: manifest.releaseSequence,
        trustPolicySequence: manifest.trustPolicySequence,
        manifestSha256: sha256(canonicalJson(manifest)),
        archiveSha256: manifest.archive.sha256,
        cosignArguments: [],
        cosignInvocations: [[]],
        manifest,
      });
      const before = new Set(
        (await readdir(tmpdir())).filter((name) =>
          name.startsWith("skillwire-quickstart-"),
        ),
      );
      await expect(
        validateSelfHostedQuickstart({
          manifest: manifestPath,
          bundles: [bundlePath],
          archive: archivePath,
          policy: policyPath,
          trustedRoot: trustedRootPath,
          cosign: binaries.cosign,
          architecture: "amd64",
          execute: false,
        }),
      ).rejects.toThrow(/tar|zstd|archive|Command failed/i);
      const after = (await readdir(tmpdir())).filter((name) =>
        name.startsWith("skillwire-quickstart-"),
      );
      expect(after.filter((name) => !before.has(name))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
