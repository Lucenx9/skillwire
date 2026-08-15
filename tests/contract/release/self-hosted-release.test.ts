import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { buildSelfHostedRelease } from "../../../scripts/build-self-hosted-release.js";
import { ReleaseManifestSchema } from "../../../src/onboarding/domain/release-manifest.js";
import {
  RELEASE_PAYLOAD_FILES,
  releasePayloadMode,
} from "../../helpers/self-hosted-release-fixtures.js";

describe("reproducible self-hosted release", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("emits an external canonical manifest bound to the archive and complete payload", async () => {
    fixture = await createOnboardingEnvironment();
    const payload = resolve(fixture.root, "payload");
    const output = resolve(fixture.root, "output");
    for (const [path, contents] of Object.entries(RELEASE_PAYLOAD_FILES)) {
      const target = resolve(payload, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, contents, { mode: releasePayloadMode(path) });
      await chmod(target, releasePayloadMode(path));
    }
    const built = await buildSelfHostedRelease({
      payloadRoot: payload,
      outputDirectory: output,
      architecture: "amd64",
      releaseVersion: "0.1.0-test.1",
      releaseSequence: 1,
      publishedAt: "2026-08-13T00:00:00.000Z",
      sourceCommit: "1".repeat(40),
      trustPolicySequence: 1,
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
    const bytes = await readFile(built.manifestPath);
    expect(bytes.at(-1)).not.toBe(0x0a);
    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const manifest = ReleaseManifestSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
    expect(manifest.payload.map(({ path }) => path)).toContain("bin/skillwire");
    expect(manifest.feature003Integrity.path).toBe(
      "distribution/codex-marketplace/release-integrity.json",
    );
    expect(manifest.components.compose.path).toBe(
      "distribution/self-hosted/compose.yaml",
    );
    expect(manifest.components.migrations).toMatchObject({
      count: 11,
      latest: "011",
      forwardOnly: ["010", "011"],
    });
    expect(manifest.components.catalog.firstPartyRevisionCount).toBe(10);
    expect(manifest.components.catalog.advisorySha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(manifest.components.adapters.codexSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.components.adapters.claudeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.archive.path).toBe(
      "skillwire-0.1.0-test.1-linux-amd64.tar.zst",
    );
    const originalArchive = await readFile(built.archivePath);
    await writeFile(resolve(payload, "app/skillwire.mjs"), "changed-payload", {
      mode: 0o644,
    });
    await expect(
      buildSelfHostedRelease({
        payloadRoot: payload,
        outputDirectory: output,
        architecture: "amd64",
        releaseVersion: "0.1.0-test.1",
        releaseSequence: 1,
        publishedAt: "2026-08-13T00:00:00.000Z",
        sourceCommit: "1".repeat(40),
        trustPolicySequence: 1,
        images: manifest.images,
      }),
    ).rejects.toThrow();
    expect(await readFile(built.archivePath)).toEqual(originalArchive);
    expect(await readFile(built.manifestPath)).toEqual(bytes);
    await writeFile(resolve(payload, "app/skillwire.mjs"), "fixture-main", {
      mode: 0o644,
    });
    const repeated = await buildSelfHostedRelease({
      payloadRoot: payload,
      outputDirectory: resolve(fixture.root, "output-repeated"),
      architecture: "amd64",
      releaseVersion: "0.1.0-test.1",
      releaseSequence: 1,
      publishedAt: "2026-08-13T00:00:00.000Z",
      sourceCommit: "1".repeat(40),
      trustPolicySequence: 1,
      images: manifest.images,
    });
    expect(await readFile(repeated.archivePath)).toEqual(
      await readFile(built.archivePath),
    );
    expect(await readFile(repeated.manifestPath)).toEqual(bytes);
  });
});
