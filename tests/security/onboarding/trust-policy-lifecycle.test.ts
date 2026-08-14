import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFakeExecutables } from "../../helpers/onboarding-executables.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import {
  bundleV03Fixture,
  canonicalJson,
  RELEASE_PAYLOAD_FILES,
  releaseManifestFixture,
  releasePayloadMode,
  sha256,
  trustPolicyFixture,
  trustedRootFixture,
} from "../../helpers/self-hosted-release-fixtures.js";
import { verifySelfHostedRelease } from "../../../src/onboarding/adapters/filesystem/release-verifier.js";

describe("offline release trust lifecycle", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  async function releaseFiles() {
    fixture = await createOnboardingEnvironment();
    const binaries = await createFakeExecutables(fixture.root);
    await chmod(binaries.cosign, 0o755);
    const root = resolve(fixture.root, "release");
    const payload = resolve(root, "payload");
    for (const [path, contents] of Object.entries(RELEASE_PAYLOAD_FILES)) {
      const target = resolve(payload, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, contents, { mode: releasePayloadMode(path) });
      await chmod(target, releasePayloadMode(path));
    }
    const archive = resolve(root, "skillwire-0.1.0-test.1-linux-amd64.tar.zst");
    await writeFile(archive, "bounded-self-hosted-archive");
    const trustedRootPath = resolve(root, "trusted-root.v1.json");
    await writeFile(trustedRootPath, canonicalJson(trustedRootFixture()));
    const cosignBytes = await readFile(binaries.cosign);
    const policy = trustPolicyFixture({
      trustedRoot: {
        path: "trusted-root.v1.json",
        sha256: sha256(canonicalJson(trustedRootFixture())),
        mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
      },
      cosign: {
        version: "3.1.3",
        binaries: {
          amd64: createHash("sha256").update(cosignBytes).digest("hex"),
          arm64: "a".repeat(64),
        },
      },
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: "2030-01-01T00:00:00.000Z",
    });
    const policyPath = resolve(root, "skillwire-trust-policy-v1.json");
    const policyBytes = canonicalJson(policy);
    await writeFile(policyPath, policyBytes, { mode: 0o600 });
    await chmod(policyPath, 0o600);
    const manifest = releaseManifestFixture({
      trustPolicy: {
        path: "skillwire-trust-policy-v1.json",
        size: Buffer.byteLength(policyBytes),
        sha256: sha256(policyBytes),
      },
    });
    const manifestPath = resolve(root, "release-manifest.json");
    await writeFile(manifestPath, canonicalJson(manifest));
    const bundlePath = resolve(
      root,
      "skillwire-0.1.0-test.1-linux-amd64.release.sigstore.json",
    );
    await writeFile(
      bundlePath,
      canonicalJson({
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        verificationMaterial: {
          certificate: { rawBytes: "Y2VydA==" },
          tlogEntries: [
            {
              logIndex: "1",
              integratedTime: "1",
              logId: { keyId: "bG9nLWlk" },
              inclusionPromise: { signedEntryTimestamp: "c2V0" },
            },
          ],
        },
        messageSignature: {
          messageDigest: {
            algorithm: "SHA2_256",
            digest: Buffer.from(
              sha256(canonicalJson(manifest)),
              "hex",
            ).toString("base64"),
          },
          signature: "c2ln",
        },
      }),
    );
    return {
      root,
      payload,
      archive,
      manifestPath,
      policyPath,
      bundlePath,
      trustedRootPath,
      cosign: binaries.cosign,
      pinnedInitialPolicySha256: sha256(policyBytes),
    };
  }

  async function bindCandidatePolicy(
    files: Awaited<ReturnType<typeof releaseFiles>>,
    policy: Record<string, unknown>,
    bundlePaths: readonly string[] = [files.bundlePath],
  ) {
    const sequence = policy["sequence"];
    if (!Number.isInteger(sequence) || Number(sequence) < 1)
      throw new Error("Fixture policy sequence is invalid");
    const policyBytes = canonicalJson(policy);
    const policyPath = resolve(
      files.root,
      `skillwire-trust-policy-v${String(sequence)}.json`,
    );
    await writeFile(policyPath, policyBytes);
    const manifest = JSON.parse(
      await readFile(files.manifestPath, "utf8"),
    ) as Record<string, unknown>;
    manifest["trustPolicySequence"] = sequence;
    manifest["trustPolicy"] = {
      path: `skillwire-trust-policy-v${String(sequence)}.json`,
      size: Buffer.byteLength(policyBytes),
      sha256: sha256(policyBytes),
    };
    const signers = policy["signers"] as { signerId: string }[];
    manifest["signatureBundles"] = bundlePaths.map((bundlePath, index) => ({
      signerId: signers[index]?.signerId,
      path: bundlePath.split("/").at(-1),
    }));
    await writeFile(files.manifestPath, canonicalJson(manifest));
    for (const [index, bundlePath] of bundlePaths.entries()) {
      const bundle = bundleV03Fixture(manifest as never);
      if (index > 0) {
        (bundle["messageSignature"] as { signature: string }).signature =
          Buffer.from(`fixture-signature-${String(index)}`).toString("base64");
      }
      await writeFile(bundlePath, canonicalJson(bundle));
    }
    return {
      ...files,
      policyPath,
      ...(Number(sequence) === 1
        ? { pinnedInitialPolicySha256: sha256(policyBytes) }
        : {}),
    };
  }

  it("accepts only the local TrustedRoot, exact claim policy, v0.3 bundle, archive, and inventory", async () => {
    const files = await releaseFiles();
    const result = await verifySelfHostedRelease({
      ...files,
      architecture: "amd64",
      currentReleaseSequence: 0,
      currentTrustSequence: 0,
    });
    expect(result.releaseSequence).toBe(1);
    expect(result.manifest.releaseSequence).toBe(1);
    const unsignedReplacement = JSON.parse(
      await readFile(files.manifestPath, "utf8"),
    ) as Record<string, unknown>;
    unsignedReplacement["releaseSequence"] = 999;
    await writeFile(files.manifestPath, canonicalJson(unsignedReplacement));
    expect(result.manifest.releaseSequence).toBe(1);
    expect(result.cosignArguments).toContain("--offline");
    expect(result.cosignArguments.join(" ")).toContain(
      "token.actions.githubusercontent.com",
    );
    expect(result.cosignArguments).toContain("--certificate-identity");
    expect(result.cosignArguments).toContain(
      "--certificate-github-workflow-repository",
    );
    expect(result.cosignArguments).toContain(
      "--certificate-github-workflow-ref",
    );
    expect(result.cosignArguments).toContain(
      "--certificate-github-workflow-sha",
    );
  });

  it("rejects digest, downgrade, deny, expiry, missing transparency, and noncanonical manifests", async () => {
    const files = await releaseFiles();
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 2,
        currentTrustSequence: 0,
      }),
    ).rejects.toThrow(/downgrade/i);
    const manifest = JSON.parse(
      await readFile(files.manifestPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      files.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 0,
        currentTrustSequence: 0,
      }),
    ).rejects.toThrow(/canonical/i);
  });

  it("rejects archive corruption, expired or noncanonical policy, and skipped policy sequences", async () => {
    let files = await releaseFiles();
    await writeFile(files.archive, "corrupted-archive");
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 0,
        currentTrustSequence: 0,
      }),
    ).rejects.toThrow(/archive identity/i);

    await writeFile(files.archive, "bounded-self-hosted-archive");
    const policy = JSON.parse(
      await readFile(files.policyPath, "utf8"),
    ) as Record<string, unknown>;
    const initialPolicy = structuredClone(policy);
    policy["validUntil"] = "2021-01-01T00:00:00.000Z";
    files = await bindCandidatePolicy(files, policy);
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 0,
        currentTrustSequence: 0,
      }),
    ).rejects.toThrow(/validity/i);

    files = await bindCandidatePolicy(files, initialPolicy);
    const currentPolicyPath = resolve(files.root, "active-policy.json");
    await writeFile(currentPolicyPath, canonicalJson(initialPolicy), {
      mode: 0o600,
    });
    await chmod(currentPolicyPath, 0o600);
    const skippedPolicy = structuredClone(initialPolicy);
    skippedPolicy["sequence"] = 3;
    files = await bindCandidatePolicy(files, skippedPolicy);
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 0,
        currentTrustSequence: 1,
        currentPolicyPath,
        currentPolicyRoot: files.root,
      }),
    ).rejects.toThrow(/skipped/i);

    files = await bindCandidatePolicy(files, initialPolicy);
    await writeFile(
      files.policyPath,
      `${JSON.stringify(initialPolicy, null, 2)}\n`,
    );
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 0,
        currentTrustSequence: 0,
      }),
    ).rejects.toThrow(/canonical/i);
  });

  it("enforces emergency deny sets and stops for out-of-band recovery when no signer survives", async () => {
    let files = await releaseFiles();
    const activePolicy = JSON.parse(
      await readFile(files.policyPath, "utf8"),
    ) as {
      sequence: number;
      signers: Record<string, unknown>[];
      overlap: { previousSequence: number | null; requiredSignerCount: number };
      deniedManifestDigests: string[];
      deniedSigners: string[];
    };
    const nextPolicy = structuredClone(activePolicy);
    nextPolicy.sequence = 2;
    nextPolicy.signers.push({
      ...nextPolicy.signers[0],
      signerId: "github-release-next",
      workflow: ".github/workflows/self-hosted-release-next.yml",
    });
    nextPolicy.overlap = { previousSequence: 1, requiredSignerCount: 2 };
    files = await bindCandidatePolicy(files, nextPolicy);
    const activePolicyPath = resolve(files.root, "active-policy.json");
    activePolicy.deniedManifestDigests = [
      sha256(await readFile(files.manifestPath)),
    ];
    await writeFile(activePolicyPath, canonicalJson(activePolicy), {
      mode: 0o600,
    });
    await chmod(activePolicyPath, 0o600);
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 0,
        currentTrustSequence: 1,
        currentPolicyPath: activePolicyPath,
        currentPolicyRoot: files.root,
      }),
    ).rejects.toThrow(/manifest digest is revoked/i);

    activePolicy.deniedManifestDigests = [];
    activePolicy.deniedSigners = ["github-release-primary"];
    await writeFile(activePolicyPath, canonicalJson(activePolicy), {
      mode: 0o600,
    });
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 0,
        currentTrustSequence: 1,
        currentPolicyPath: activePolicyPath,
        currentPolicyRoot: files.root,
      }),
    ).rejects.toThrow(/out-of-band trust bootstrap/i);
  });

  it("rejects empty signatures and transparency entries without offline evidence", async () => {
    const files = await releaseFiles();
    const bundle = JSON.parse(await readFile(files.bundlePath, "utf8")) as {
      messageSignature: { signature: string };
      verificationMaterial: { tlogEntries: Record<string, unknown>[] };
    };
    bundle.messageSignature.signature = "";
    await writeFile(files.bundlePath, canonicalJson(bundle));
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 0,
        currentTrustSequence: 0,
      }),
    ).rejects.toThrow(/signature/i);

    bundle.messageSignature.signature = "c2ln";
    bundle.verificationMaterial.tlogEntries = [
      { logIndex: "1", integratedTime: "1", logId: { keyId: "bG9n" } },
    ];
    await writeFile(files.bundlePath, canonicalJson(bundle));
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 0,
        currentTrustSequence: 0,
      }),
    ).rejects.toThrow(/transparency/i);
  });

  it("requires and verifies both signer bundles during an overlap policy", async () => {
    let files = await releaseFiles();
    const currentPolicyPath = files.policyPath;
    const secondBundle = resolve(
      files.root,
      "skillwire-0.1.0-test.1-linux-amd64.release.github-release-next.sigstore.json",
    );
    const policy = JSON.parse(await readFile(files.policyPath, "utf8")) as {
      sequence: number;
      signers: Record<string, unknown>[];
      overlap: { previousSequence: number | null; requiredSignerCount: number };
    };
    policy.signers.push({
      ...policy.signers[0],
      signerId: "github-release-next",
      workflow: ".github/workflows/self-hosted-release-next.yml",
    });
    policy.sequence = 2;
    policy.overlap = { previousSequence: 1, requiredSignerCount: 2 };
    files = await bindCandidatePolicy(files, policy, [
      files.bundlePath,
      secondBundle,
    ]);
    const result = await verifySelfHostedRelease({
      ...files,
      bundlePaths: [files.bundlePath, secondBundle],
      architecture: "amd64",
      currentReleaseSequence: 0,
      currentTrustSequence: 1,
      currentPolicyPath,
      currentPolicyRoot: files.root,
    });
    expect(result.cosignInvocations).toHaveLength(2);
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 0,
        currentTrustSequence: 1,
        currentPolicyPath,
        currentPolicyRoot: files.root,
      }),
    ).rejects.toThrow(/overlap|bundle/i);
  });

  it("requires the complete active two-signer quorum before replacing one signer", async () => {
    let files = await releaseFiles();
    const activePolicy = JSON.parse(
      await readFile(files.policyPath, "utf8"),
    ) as {
      sequence: number;
      signers: Record<string, unknown>[];
      overlap: { previousSequence: number | null; requiredSignerCount: number };
    };
    activePolicy.sequence = 2;
    activePolicy.signers.push({
      ...activePolicy.signers[0],
      signerId: "github-release-secondary",
      workflow: ".github/workflows/self-hosted-release-secondary.yml",
    });
    activePolicy.overlap = { previousSequence: 1, requiredSignerCount: 2 };
    const activePolicyPath = resolve(files.root, "active-policy.json");
    await writeFile(activePolicyPath, canonicalJson(activePolicy), {
      mode: 0o600,
    });
    await chmod(activePolicyPath, 0o600);

    const candidatePolicy = structuredClone(activePolicy);
    candidatePolicy.sequence = 3;
    candidatePolicy.signers[1] = {
      ...candidatePolicy.signers[1],
      signerId: "github-release-attacker",
      workflow: ".github/workflows/self-hosted-release-attacker.yml",
    };
    candidatePolicy.overlap = { previousSequence: 2, requiredSignerCount: 2 };
    const attackerBundle = resolve(
      files.root,
      "skillwire-0.1.0-test.1-linux-amd64.release.github-release-attacker.sigstore.json",
    );
    files = await bindCandidatePolicy(files, candidatePolicy, [
      files.bundlePath,
      attackerBundle,
    ]);

    await expect(
      verifySelfHostedRelease({
        ...files,
        bundlePaths: [files.bundlePath, attackerBundle],
        architecture: "amd64",
        currentReleaseSequence: 1,
        currentTrustSequence: 2,
        currentPolicyPath: activePolicyPath,
        currentPolicyRoot: files.root,
      }),
    ).rejects.toThrow(/active.*quorum|current.*signer/i);

    const manifest = JSON.parse(
      await readFile(files.manifestPath, "utf8"),
    ) as Record<string, unknown>;
    const signatureBundles = manifest["signatureBundles"] as {
      signerId: string;
      path: string;
    }[];
    if (signatureBundles[1] === undefined)
      throw new Error("fixture second bundle is unavailable");
    signatureBundles[1].signerId = "github-release-secondary";
    const secondaryBundle = resolve(
      files.root,
      "skillwire-0.1.0-test.1-linux-amd64.release.github-release-secondary.sigstore.json",
    );
    signatureBundles[1].path = secondaryBundle.split("/").at(-1) ?? "";
    await writeFile(files.manifestPath, canonicalJson(manifest));
    for (const [index, bundlePath] of [
      files.bundlePath,
      secondaryBundle,
    ].entries()) {
      const bundle = bundleV03Fixture(manifest as never);
      if (index > 0)
        (bundle["messageSignature"] as { signature: string }).signature =
          Buffer.from("fixture-secondary-signature").toString("base64");
      await writeFile(bundlePath, canonicalJson(bundle));
    }
    await expect(
      verifySelfHostedRelease({
        ...files,
        bundlePaths: [files.bundlePath, secondaryBundle],
        architecture: "amd64",
        currentReleaseSequence: 1,
        currentTrustSequence: 2,
        currentPolicyPath: activePolicyPath,
        currentPolicyRoot: files.root,
      }),
    ).resolves.toMatchObject({ trustPolicySequence: 3 });
  });

  it("requires a protected, currently valid authorizing policy whose release floor is preserved", async () => {
    let files = await releaseFiles();
    const activePolicy = JSON.parse(
      await readFile(files.policyPath, "utf8"),
    ) as Record<string, unknown>;
    const activePolicyPath = resolve(files.root, "active-policy.json");
    await writeFile(activePolicyPath, canonicalJson(activePolicy), {
      mode: 0o600,
    });
    await chmod(activePolicyPath, 0o600);

    const nextPolicy = structuredClone(activePolicy);
    nextPolicy["sequence"] = 2;
    nextPolicy["validUntil"] = "2035-01-01T00:00:00.000Z";
    (nextPolicy["signers"] as Record<string, unknown>[]).push({
      ...(nextPolicy["signers"] as Record<string, unknown>[])[0],
      signerId: "github-release-next",
      workflow: ".github/workflows/self-hosted-release-next.yml",
    });
    nextPolicy["overlap"] = {
      previousSequence: 1,
      requiredSignerCount: 2,
    };
    const nextBundle = resolve(
      files.root,
      "skillwire-0.1.0-test.1-linux-amd64.release.github-release-next.sigstore.json",
    );
    files = await bindCandidatePolicy(files, nextPolicy, [
      files.bundlePath,
      nextBundle,
    ]);

    await chmod(activePolicyPath, 0o644);
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 1,
        currentTrustSequence: 1,
        currentPolicyPath: activePolicyPath,
        currentPolicyRoot: files.root,
        bundlePaths: [files.bundlePath, nextBundle],
        now: new Date("2029-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/mode|protected|owned/i);

    await chmod(activePolicyPath, 0o600);
    activePolicy["validUntil"] = "2028-01-01T00:00:00.000Z";
    await writeFile(activePolicyPath, canonicalJson(activePolicy), {
      mode: 0o600,
    });
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 1,
        currentTrustSequence: 1,
        currentPolicyPath: activePolicyPath,
        currentPolicyRoot: files.root,
        bundlePaths: [files.bundlePath, nextBundle],
        now: new Date("2029-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/authorizing.*validity/i);

    activePolicy["validUntil"] = "2030-01-01T00:00:00.000Z";
    activePolicy["minimumReleaseSequence"] = 3;
    await writeFile(activePolicyPath, canonicalJson(activePolicy), {
      mode: 0o600,
    });
    await expect(
      verifySelfHostedRelease({
        ...files,
        architecture: "amd64",
        currentReleaseSequence: 1,
        currentTrustSequence: 1,
        currentPolicyPath: activePolicyPath,
        currentPolicyRoot: files.root,
        bundlePaths: [files.bundlePath, nextBundle],
        now: new Date("2029-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/authorizing.*minimum/i);
  });
});
