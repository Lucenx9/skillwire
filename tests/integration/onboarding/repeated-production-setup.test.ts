import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildSelfHostedRelease } from "../../../scripts/build-self-hosted-release.js";
import { runProductionSetup } from "../../../src/onboarding/application/production-setup.js";
import {
  currentProcessIdentity,
  InstallationLock,
} from "../../../src/onboarding/domain/operation-journal.js";
import { snapshotTree } from "../../helpers/filesystem-snapshot.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { createFakeExecutables } from "../../helpers/onboarding-executables.js";
import {
  bundleV03Fixture,
  canonicalJson,
  RELEASE_PAYLOAD_FILES,
  releasePayloadMode,
  sha256,
  trustedRootFixture,
  trustPolicyFixture,
} from "../../helpers/self-hosted-release-fixtures.js";

async function preparePersistedSetup(fixture: OnboardingEnvironment): Promise<{
  readonly environment: NodeJS.ProcessEnv;
  readonly installationId: string;
  readonly pinnedInitialPolicySha256: string;
  readonly stateRoot: string;
}> {
  const candidateDirectory = resolve(fixture.root, "candidate");
  const candidateRoot = resolve(
    candidateDirectory,
    "skillwire-0.1.0-test.1-linux-amd64",
  );
  await mkdir(candidateRoot, { recursive: true, mode: 0o700 });
  for (const [path, contents] of Object.entries(RELEASE_PAYLOAD_FILES)) {
    const target = resolve(candidateRoot, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, { mode: releasePayloadMode(path) });
    await chmod(target, releasePayloadMode(path));
  }

  const trustedRootText = canonicalJson(trustedRootFixture());
  await writeFile(
    resolve(candidateRoot, "distribution/self-hosted/trusted-root.v1.json"),
    trustedRootText,
    { mode: 0o644 },
  );
  const fake = await createFakeExecutables(fixture.root);
  const cosignPath = resolve(candidateRoot, "tools/cosign");
  await mkdir(dirname(cosignPath), { recursive: true, mode: 0o700 });
  await copyFile(fake.cosign, cosignPath);
  await chmod(cosignPath, 0o755);
  const policy = trustPolicyFixture({
    trustedRoot: {
      path: "trusted-root.v1.json",
      sha256: sha256(trustedRootText),
      mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    },
    cosign: {
      version: "3.1.3",
      binaries: {
        amd64: sha256(await readFile(cosignPath)),
        arm64: "a".repeat(64),
      },
    },
  });
  const policyPath = resolve(
    candidateDirectory,
    "skillwire-trust-policy-v1.json",
  );
  const policyBytes = canonicalJson(policy);
  await writeFile(policyPath, policyBytes, { mode: 0o600 });
  const built = await buildSelfHostedRelease({
    payloadRoot: candidateRoot,
    outputDirectory: candidateDirectory,
    architecture: "amd64",
    releaseVersion: "0.1.0-test.1",
    releaseSequence: 1,
    publishedAt: "2026-08-13T00:00:00.000Z",
    sourceCommit: "1".repeat(40),
    trustPolicySequence: 1,
    trustPolicyPath: policyPath,
    images: [
      {
        role: "skillwire",
        repository: "ghcr.io/lucenx9/skillwire",
        digest: `sha256:${sha256("image")}`,
        platform: "linux/amd64",
      },
      {
        role: "postgres",
        repository: "docker.io/library/postgres",
        digest: `sha256:${sha256("postgres-image")}`,
        platform: "linux/amd64",
      },
    ],
  });
  await writeFile(
    resolve(
      candidateDirectory,
      "skillwire-0.1.0-test.1-linux-amd64.release.sigstore.json",
    ),
    canonicalJson(bundleV03Fixture(built.manifest)),
    { mode: 0o600 },
  );

  const stateRoot = resolve(fixture.xdgStateHome, "skillwire");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const installationId = randomUUID();
  const now = new Date().toISOString();
  const socketPath = resolve(fixture.runtimeRoot, "skillwire/absent/mcp.sock");
  await writeFile(
    resolve(stateRoot, "installation.json"),
    JSON.stringify({
      schemaVersion: "skillwire.installation/v1",
      installationId,
      ownerUid: process.getuid?.() ?? 1000,
      accountId: randomUUID(),
      activeReleaseId: "1-amd64",
      highestAcceptedReleaseSequence: 1,
      activeTrustPolicySequence: 1,
      endpoint: `unix://${socketPath}`,
      composeProject: fixture.composeProject,
      postgresVolume: fixture.postgresVolume,
      selectedClients: [],
      clientIntegrationIds: { codex: null, claude: null },
      status: "service-ready",
      createdAt: now,
      updatedAt: now,
      lastValidatedAt: now,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    resolve(stateRoot, "client-integrations.json"),
    JSON.stringify({
      schemaVersion: "skillwire.client-integrations/v1",
      installationId,
      integrations: [],
    }),
    { mode: 0o600 },
  );
  return {
    environment: {
      ...fixture.environment,
      SKILLWIRE_RELEASE_ROOT: candidateRoot,
    },
    installationId,
    pinnedInitialPolicySha256: sha256(policyBytes),
    stateRoot,
  };
}

describe("repeated production setup live verification", () => {
  let fixture: OnboardingEnvironment | undefined;

  afterEach(async () => fixture?.close());

  it("refuses persisted service-ready metadata when the live service is absent", async () => {
    fixture = await createOnboardingEnvironment();
    const setup = await preparePersistedSetup(fixture);
    const stateBefore = await snapshotTree(setup.stateRoot);

    await expect(
      runProductionSetup(
        { clients: "none", credentialBackend: "not-selected" },
        new AbortController().signal,
        setup.environment,
        {
          pinnedInitialPolicySha256: setup.pinnedInitialPolicySha256,
        },
      ),
    ).rejects.toThrow(/deployment|live|ready|service|state/i);

    expect(await snapshotTree(setup.stateRoot)).toEqual(stateBefore);
    await expect(
      readFile(resolve(fixture.home, ".codex/config.toml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(resolve(fixture.home, ".claude.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("acquires the installation lock before deciding a setup is unchanged", async () => {
    fixture = await createOnboardingEnvironment();
    const setup = await preparePersistedSetup(fixture);
    const lockRoot = resolve(fixture.runtimeRoot, "skillwire/locks");
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const held = await InstallationLock.acquire(
      lockRoot,
      "installation",
      await currentProcessIdentity(),
    );
    try {
      await expect(
        runProductionSetup(
          { clients: "none", credentialBackend: "not-selected" },
          new AbortController().signal,
          setup.environment,
          {
            pinnedInitialPolicySha256: setup.pinnedInitialPolicySha256,
          },
        ),
      ).rejects.toThrow(/locked|operation/i);
    } finally {
      await held.release();
    }
  });
});
