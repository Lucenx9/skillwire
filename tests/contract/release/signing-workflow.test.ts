import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  overlapBundlePaths,
  signingArguments,
} from "../../../scripts/sign-self-hosted-release.js";

describe("protected self-hosted signing", () => {
  it("uses pinned Cosign 3.1.3 keyless sign-blob Bundle v0.3 invocation", () => {
    expect(
      signingArguments(
        "/release/manifest.json",
        "/release/manifest.sigstore.json",
      ),
    ).toEqual([
      "sign-blob",
      "--yes",
      "--timeout",
      "2m",
      "--oidc-provider",
      "github-actions",
      "--signing-algorithm",
      "ecdsa-sha2-256-nistp256",
      "--bundle",
      "/release/manifest.sigstore.json",
      "/release/manifest.json",
    ]);
    const workflow = readFileSync(
      resolve(".github/workflows/self-hosted-release.yml"),
      "utf8",
    );
    expect(workflow).toContain("COSIGN_VERSION: 3.1.3");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).toContain("sign-blob");
    expect(workflow).toContain("--bundle");
    expect(workflow).toContain("refs/tags/self-hosted-v");
    expect(workflow).toContain("verify-self-hosted-release-tag.ts");
    expect(workflow).toContain('--repository "${GITHUB_WORKSPACE}"');
    expect(workflow).toContain('--ref "${GITHUB_REF}"');
    expect(workflow).toContain('--sha "${GITHUB_SHA}"');
    expect(workflow).toContain('--manifest "${manifest}"');
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).not.toContain("git config --global");
    const buildJob = workflow.slice(workflow.indexOf("  build-test-sign:"));
    expect(buildJob.indexOf("verify-self-hosted-release-tag.ts")).toBeLessThan(
      buildJob.indexOf("pnpm install --frozen-lockfile"),
    );
    expect(buildJob.indexOf("verify-self-hosted-release-tag.ts")).toBeLessThan(
      buildJob.indexOf("pnpm format:check && pnpm lint"),
    );
    expect(workflow).toContain(
      "node scripts/verify-self-hosted-release-tag.ts",
    );
    const certifiedJob = workflow.slice(
      workflow.indexOf("  certified-matrix:"),
      workflow.indexOf("  build-test-sign:"),
    );
    expect(
      certifiedJob.indexOf("verify-self-hosted-release-tag.ts"),
    ).toBeLessThan(certifiedJob.indexOf("pnpm install --frozen-lockfile"));
    expect(workflow).toContain('--title "SkillWire Self-Hosted v${VERSION}"');
    const tagVerifier = readFileSync(
      resolve("scripts/verify-self-hosted-release-tag.ts"),
      "utf8",
    );
    expect(tagVerifier).toContain("`safe.directory=${repositoryRoot}`");
    expect(tagVerifier).not.toContain("config --global");
    expect(workflow).toContain("needs: build-test-sign");
    expect(workflow).toContain(
      "github.ref == format('refs/tags/self-hosted-v{0}'",
    );
    expect(workflow).toContain("pnpm build:self-hosted \\");
    expect(workflow).toContain("pnpm verify:self-hosted \\");
    expect(workflow).toContain("NODE_VERSION: 24.18.0");
    expect(workflow).toContain("node-v${NODE_VERSION}-linux-${node_arch}");
    expect(workflow).toContain("cosign-linux-arm64");
    expect(workflow).toContain(
      "c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a",
    );
    expect(workflow).toContain('"${RUNNER_TEMP}/cosign-host" sign-blob');
    expect(workflow).toContain(
      '"${RUNNER_TEMP}/cosign-${ARCH}" "${payload}/tools/cosign"',
    );
    expect(workflow).toContain("SKILLWIRE_RELEASE_IMAGES_JSON");
    expect(workflow).toContain("skillwire-${VERSION}-linux-${ARCH}");
    expect(workflow).not.toContain("release-manifest.json");
    expect(workflow).not.toContain("skillwire-self-hosted-linux-amd64.tar.zst");
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
  });

  it("derives one separately named additional bundle for signer overlap", () => {
    expect(
      overlapBundlePaths("/release/manifest.sigstore.json", [
        "github-release-next",
      ]),
    ).toEqual([
      "/release/manifest.sigstore.json",
      "/release/manifest.github-release-next.sigstore.json",
    ]);
    expect(() =>
      overlapBundlePaths("/release/manifest.sigstore.json", ["next", "third"]),
    ).toThrow(/two signer/i);
  });
});
