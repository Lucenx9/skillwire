import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildSelfHostedRelease } from "../../../scripts/build-self-hosted-release.js";
import {
  installVerifiedRelease,
  releaseDirectoryIdentity,
} from "../../../src/onboarding/adapters/filesystem/release-installer.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import {
  RELEASE_PAYLOAD_FILES,
  releasePayloadMode,
} from "../../helpers/self-hosted-release-fixtures.js";

describe("immutable self-hosted release installer", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("safely extracts a verified archive, installs a stable launcher, active selection, and ownership", async () => {
    fixture = await createOnboardingEnvironment();
    const payload = resolve(fixture.root, "payload");
    for (const [path, contents] of Object.entries(RELEASE_PAYLOAD_FILES)) {
      const target = resolve(payload, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, contents, { mode: releasePayloadMode(path) });
      await chmod(target, releasePayloadMode(path));
    }
    const built = await buildSelfHostedRelease({
      payloadRoot: payload,
      outputDirectory: resolve(fixture.root, "release"),
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
    const manifestSha256 = createHash("sha256")
      .update(await readFile(built.manifestPath))
      .digest("hex");
    const trustPolicyPath = resolve(
      "distribution/self-hosted/trust-policy.v1.json",
    );
    const originalArchive = await readFile(built.archivePath);
    await appendFile(built.archivePath, "unbound-trailing-bytes");
    await expect(
      installVerifiedRelease({
        archivePath: built.archivePath,
        manifest: built.manifest,
        dataRoot: fixture.stateRoot,
        stateRoot: resolve(fixture.xdgStateHome, "skillwire"),
        launcherRoot: fixture.home,
        launcherPath: resolve(fixture.home, ".local/bin/skillwire"),
        installationId: "00000000-0000-4000-8000-000000000001",
        manifestSha256,
        trustPolicyPath,
      }),
    ).rejects.toThrow(/archive identity/i);
    await writeFile(built.archivePath, originalArchive);
    const result = await installVerifiedRelease({
      archivePath: built.archivePath,
      manifest: built.manifest,
      dataRoot: fixture.stateRoot,
      stateRoot: resolve(fixture.xdgStateHome, "skillwire"),
      launcherRoot: fixture.home,
      launcherPath: resolve(fixture.home, ".local/bin/skillwire"),
      installationId: "00000000-0000-4000-8000-000000000001",
      manifestSha256,
      trustPolicyPath,
    });
    expect(result.releaseRoot).toContain(
      "releases/skillwire-0.1.0-test.1-linux-amd64",
    );
    expect(result.launcherPath).toBe(
      resolve(fixture.home, ".local/bin/skillwire"),
    );
    expect(await readFile(result.launcherPath, "utf8")).toContain(
      "SKILLWIRE_RELEASE_ROOT",
    );
    expect(
      JSON.parse(
        await readFile(
          resolve(fixture.xdgStateHome, "skillwire/active-release.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ releaseSequence: 1 });
    expect(
      JSON.parse(await readFile(result.ownershipPath, "utf8")),
    ).toMatchObject({ kind: "release" });
    const repeated = await installVerifiedRelease({
      archivePath: built.archivePath,
      manifest: built.manifest,
      dataRoot: fixture.stateRoot,
      stateRoot: resolve(fixture.xdgStateHome, "skillwire"),
      launcherRoot: fixture.home,
      launcherPath: resolve(fixture.home, ".local/bin/skillwire"),
      installationId: "00000000-0000-4000-8000-000000000001",
      manifestSha256,
      trustPolicyPath,
    });
    expect(repeated.changed).toBe(false);
    const installedIdentity = await releaseDirectoryIdentity(
      result.releaseRoot,
    );
    await appendFile(resolve(result.releaseRoot, "app/skillwire.mjs"), "drift");
    await expect(
      releaseDirectoryIdentity(result.releaseRoot),
    ).resolves.not.toBe(installedIdentity);
  });
});
import { createHash } from "node:crypto";
