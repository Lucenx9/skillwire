import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
import { buildSelfHostedRelease } from "../../../scripts/build-self-hosted-release.js";
import {
  previewProductionSetup,
  runProductionSetup,
} from "../../../src/onboarding/application/production-setup.js";
import { canonicalPreview } from "../../../src/onboarding/cli/confirmation.js";

describe("compiled guided setup route", () => {
  let fixture: OnboardingEnvironment | undefined;

  afterEach(async () => fixture?.close());

  it("resolves a release-derived, redacted no-client preview without mutation", async () => {
    fixture = await createOnboardingEnvironment();
    const releaseRoot = resolve(
      fixture.root,
      "candidate/skillwire-0.1.0-test.1-linux-amd64",
    );
    await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
    for (const [path, contents] of Object.entries(RELEASE_PAYLOAD_FILES)) {
      const target = resolve(releaseRoot, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, contents, { mode: releasePayloadMode(path) });
      await chmod(target, releasePayloadMode(path));
    }
    const trustedRootText = canonicalJson(trustedRootFixture());
    const trustedRootPath = resolve(
      releaseRoot,
      "distribution/self-hosted/trusted-root.v1.json",
    );
    await writeFile(trustedRootPath, trustedRootText, { mode: 0o644 });
    const fake = await createFakeExecutables(fixture.root);
    const cosignPath = resolve(releaseRoot, "tools/cosign");
    await mkdir(dirname(cosignPath), { recursive: true, mode: 0o700 });
    await copyFile(fake.cosign, cosignPath);
    await chmod(cosignPath, 0o755);
    const policy = trustPolicyFixture({
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: "2030-01-01T00:00:00.000Z",
      trustedRoot: {
        path: "trusted-root.v1.json",
        sha256: sha256(trustedRootText),
        mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
      },
      cosign: {
        version: "3.1.3",
        binaries: {
          amd64: createHash("sha256")
            .update(await readFile(cosignPath))
            .digest("hex"),
          arm64: "a".repeat(64),
        },
      },
    });
    const policyPath = resolve(
      fixture.root,
      "candidate/skillwire-trust-policy-v1.json",
    );
    const policyBytes = canonicalJson(policy);
    await writeFile(policyPath, policyBytes, { mode: 0o600 });
    const built = await buildSelfHostedRelease({
      payloadRoot: releaseRoot,
      outputDirectory: resolve(fixture.root, "candidate"),
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
          digest: `sha256:${"1".repeat(64)}`,
          platform: "linux/amd64",
        },
        {
          role: "postgres",
          repository: "docker.io/library/postgres",
          digest: `sha256:${"2".repeat(64)}`,
          platform: "linux/amd64",
        },
      ],
    });
    await writeFile(
      resolve(
        fixture.root,
        "candidate/skillwire-0.1.0-test.1-linux-amd64.release.sigstore.json",
      ),
      canonicalJson(bundleV03Fixture(built.manifest)),
      { mode: 0o600 },
    );
    const scope = await previewProductionSetup(
      { clients: "none" },
      {
        ...fixture.environment,
        SKILLWIRE_RELEASE_ROOT: releaseRoot,
      },
      { pinnedInitialPolicySha256: sha256(policyBytes) },
    );
    const preview = canonicalPreview("setup", scope);
    expect(preview.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.json).not.toMatch(
      /swk\.|Bearer|password\s*[=:]|pepper\s*[=:]/i,
    );
    const sourceScope = await previewProductionSetup(
      {
        clients: "none",
        sources: ["mattpocock/skills", "obra/superpowers"],
      },
      {
        ...fixture.environment,
        SKILLWIRE_RELEASE_ROOT: releaseRoot,
      },
      { pinnedInitialPolicySha256: sha256(policyBytes) },
    );
    const sourcePreview = canonicalPreview("setup", sourceScope);
    expect(sourceScope).toMatchObject({
      catalogChoice: "bundled-first-party",
      sources: ["mattpocock/skills", "obra/superpowers"],
    });
    expect(sourcePreview.hash).not.toBe(preview.hash);
    expect(sourcePreview.json).not.toMatch(
      /github_pat_|ghp_|Bearer|password\s*[=:]|pepper\s*[=:]/i,
    );
    await expect(
      runProductionSetup(
        {
          clients: "none",
          credentialBackend: "not-selected",
          previewHash: "0".repeat(64),
        },
        new AbortController().signal,
        {
          ...fixture.environment,
          SKILLWIRE_RELEASE_ROOT: releaseRoot,
        },
        { pinnedInitialPolicySha256: sha256(policyBytes) },
      ),
    ).rejects.toThrow(/preview hash confirmation/i);
  });
});
