import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildSelfHostedRelease } from "../../../scripts/build-self-hosted-release.js";
import { buildSelfHostedApplication } from "../../../scripts/build-self-hosted-app.js";
import {
  previewProductionSetup,
  runProductionSetup,
} from "../../../src/onboarding/application/production-setup.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { snapshotTree } from "../../helpers/filesystem-snapshot.js";
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

const exec = promisify(execFile);
const postgresDigest =
  "742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";

async function freePort(): Promise<number> {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Unable to allocate a disposable loopback port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) done(address.port);
        else reject(error);
      });
    });
  });
}

async function dockerInventory(
  kind: "container" | "volume",
): Promise<Set<string>> {
  const result = await exec("/usr/bin/docker", [
    kind,
    "ls",
    ...(kind === "container" ? ["--all"] : []),
    "--quiet",
  ]);
  return new Set(result.stdout.split("\n").filter(Boolean));
}

describe("real disposable production setup", () => {
  let fixture: OnboardingEnvironment | undefined;
  const createdContainers = new Set<string>();
  const createdVolumes = new Set<string>();
  let registryName: string | undefined;
  let pushedImage: string | undefined;
  let baselineContainers = new Set<string>();
  let baselineVolumes = new Set<string>();

  beforeAll(async () => {
    if (process.env["SKILLWIRE_RUN_COMPOSE_INTEGRATION"] === "1") {
      await exec("pnpm", ["build"], { cwd: process.cwd() });
    }
  });

  afterEach(async () => {
    const currentContainers = await dockerInventory("container").catch(
      () => new Set<string>(),
    );
    const currentVolumes = await dockerInventory("volume").catch(
      () => new Set<string>(),
    );
    for (const id of currentContainers) {
      if (!baselineContainers.has(id)) createdContainers.add(id);
    }
    for (const name of currentVolumes) {
      if (!baselineVolumes.has(name)) createdVolumes.add(name);
    }
    for (const id of createdContainers) {
      await exec("/usr/bin/docker", ["container", "rm", "--force", id]).catch(
        () => undefined,
      );
    }
    for (const name of createdVolumes) {
      await exec("/usr/bin/docker", ["volume", "rm", name]).catch(
        () => undefined,
      );
    }
    if (registryName !== undefined) {
      await exec("/usr/bin/docker", [
        "container",
        "rm",
        "--force",
        registryName,
      ]).catch(() => undefined);
    }
    if (pushedImage !== undefined) {
      await exec("/usr/bin/docker", ["image", "rm", pushedImage]).catch(
        () => undefined,
      );
    }
    await fixture?.close();
    fixture = undefined;
    createdContainers.clear();
    createdVolumes.clear();
    baselineContainers = new Set<string>();
    baselineVolumes = new Set<string>();
    registryName = undefined;
    pushedImage = undefined;
  });

  it.skipIf(process.env["SKILLWIRE_RUN_COMPOSE_INTEGRATION"] !== "1")(
    "installs without clients, then verifies both native clients from simulated normal profiles",
    async () => {
      fixture = await createOnboardingEnvironment();
      baselineContainers = await dockerInventory("container");
      baselineVolumes = await dockerInventory("volume");
      const registryPort = await freePort();
      registryName = `${fixture.composeProject}-registry`;
      await exec(
        "/usr/bin/docker",
        [
          "run",
          "--detach",
          "--name",
          registryName,
          "--publish",
          `127.0.0.1:${String(registryPort)}:5000`,
          "registry:2",
        ],
        { timeout: 120_000 },
      );
      const repository = `localhost:${String(registryPort)}/skillwire`;
      const taggedImage = `${repository}:feature004`;
      await exec("/usr/bin/docker", ["build", "--tag", taggedImage, "."], {
        cwd: process.cwd(),
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      await exec("/usr/bin/docker", ["push", taggedImage], {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const repoDigests = await exec("/usr/bin/docker", [
        "image",
        "inspect",
        "--format",
        "{{json .RepoDigests}}",
        taggedImage,
      ]);
      const digestReference = (
        JSON.parse(repoDigests.stdout.trim()) as string[]
      ).find((entry) => entry.startsWith(`${repository}@sha256:`));
      if (digestReference === undefined) {
        throw new Error(
          "Disposable registry did not return a repository digest",
        );
      }
      pushedImage = taggedImage;
      const digest = digestReference.slice(digestReference.indexOf("@") + 1);

      const candidateRoot = resolve(
        fixture.root,
        "candidate/skillwire-0.1.0-test.1-linux-amd64",
      );
      await mkdir(candidateRoot, { recursive: true, mode: 0o700 });
      for (const [path, contents] of Object.entries(RELEASE_PAYLOAD_FILES)) {
        const target = resolve(candidateRoot, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, contents, { mode: releasePayloadMode(path) });
        await chmod(target, releasePayloadMode(path));
      }
      await copyFile(
        resolve("distribution/self-hosted/compose.yaml"),
        resolve(candidateRoot, "distribution/self-hosted/compose.yaml"),
      );
      await chmod(
        resolve(candidateRoot, "distribution/self-hosted/compose.yaml"),
        0o644,
      );
      await cp(
        resolve("distribution/codex-release-marketplace"),
        resolve(candidateRoot, "distribution/codex-release-marketplace"),
        { recursive: true, force: true },
      );
      await cp(
        resolve("distribution/claude-marketplace"),
        resolve(candidateRoot, "distribution/claude-marketplace"),
        { recursive: true, force: true },
      );
      await buildSelfHostedApplication({
        esbuildExecutable: resolve("node_modules/esbuild/bin/esbuild"),
        entrypoint: resolve("src/onboarding/cli/main.ts"),
        output: resolve(candidateRoot, "app/skillwire.mjs"),
      });
      await copyFile(process.execPath, resolve(candidateRoot, "runtime/node"));
      await chmod(resolve(candidateRoot, "runtime/node"), 0o755);
      const trustedRootText = canonicalJson(trustedRootFixture());
      const trustedRootPath = resolve(
        candidateRoot,
        "distribution/self-hosted/trusted-root.v1.json",
      );
      await writeFile(trustedRootPath, trustedRootText, { mode: 0o644 });
      const fake = await createFakeExecutables(fixture.root);
      const cosignPath = resolve(candidateRoot, "tools/cosign");
      await mkdir(dirname(cosignPath), { recursive: true, mode: 0o700 });
      await copyFile(fake.cosign, cosignPath);
      await chmod(cosignPath, 0o755);
      const policy = trustPolicyFixture({
        validFrom: "2020-01-01T00:00:00.000Z",
        validUntil: "2030-01-01T00:00:00.000Z",
        trustedRoot: {
          path: "trusted-root.v1.json",
          sha256: sha256(trustedRootText),
          mediaType:
            "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
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
        payloadRoot: candidateRoot,
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
            repository,
            digest,
            platform: "linux/amd64",
          },
          {
            role: "postgres",
            repository: "docker.io/library/postgres",
            digest: `sha256:${postgresDigest}`,
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

      const environment = {
        ...fixture.environment,
        SKILLWIRE_RELEASE_ROOT: candidateRoot,
      };
      const preview = await previewProductionSetup(
        { clients: "none" },
        environment,
        { pinnedInitialPolicySha256: sha256(policyBytes) },
      );
      expect(preview).toMatchObject({
        endpoint: `unix://${resolve(fixture.runtimeRoot, "skillwire/s-<installation-id-sha256-prefix>/mcp.sock")}`,
        transport: "unix-domain-socket",
        port: null,
      });
      const result = await runProductionSetup(
        { clients: "none", credentialBackend: "not-selected" },
        new AbortController().signal,
        environment,
        { pinnedInitialPolicySha256: sha256(policyBytes) },
      );
      expect(result).toMatchObject({ status: "success", serviceReady: true });
      expect(result.clients).toEqual([]);
      expect(
        await readFile(
          resolve(fixture.xdgStateHome, "skillwire/installation.json"),
          "utf8",
        ),
      ).toContain('"status":"service-ready"');
      await expect(
        readFile(resolve(fixture.home, ".codex/config.toml"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(resolve(fixture.home, ".claude.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const clientEnvironment = {
        ...fixture.environment,
        SKILLWIRE_RELEASE_ROOT: candidateRoot,
      };
      const clientPreview = await previewProductionSetup(
        { clients: "codex,claude" },
        clientEnvironment,
        { pinnedInitialPolicySha256: sha256(policyBytes) },
      );
      expect(clientPreview).toMatchObject({
        clients: "codex,claude",
        endpoint: `unix://${resolve(fixture.runtimeRoot, "skillwire/s-<installation-id-sha256-prefix>/mcp.sock")}`,
        transport: "unix-domain-socket",
        port: null,
        credentialBackend: "restrictive-file",
        fallbackRiskConfirmedByThisPreview: true,
      });
      const clientResult = await runProductionSetup(
        { clients: "codex,claude", credentialBackend: "restrictive-file" },
        new AbortController().signal,
        clientEnvironment,
        { pinnedInitialPolicySha256: sha256(policyBytes) },
      );
      expect(clientResult).toMatchObject({
        status: "success",
        serviceReady: true,
      });
      expect(clientResult.clients).toMatchObject([
        { client: "codex", status: "verified", compensated: false },
        { client: "claude", status: "verified", compensated: false },
      ]);
      expect(
        await readFile(resolve(fixture.home, ".codex/config.toml"), "utf8"),
      ).toContain("[mcp_servers.skillwire]");
      expect(
        await readFile(resolve(fixture.home, ".claude.json"), "utf8"),
      ).toContain('"skillwire"');

      const stateBeforeRepeat = await snapshotTree(
        resolve(fixture.xdgStateHome, "skillwire"),
      );
      const profilesBeforeRepeat = await snapshotTree(fixture.home);
      const unchanged = await runProductionSetup(
        { clients: "none", credentialBackend: "not-selected" },
        new AbortController().signal,
        clientEnvironment,
        { pinnedInitialPolicySha256: sha256(policyBytes) },
      );
      expect(unchanged).toMatchObject({
        status: "success",
        serviceReady: true,
        clients: [],
        changed: false,
      });
      expect(
        await snapshotTree(resolve(fixture.xdgStateHome, "skillwire")),
      ).toEqual(stateBeforeRepeat);
      expect(await snapshotTree(fixture.home)).toEqual(profilesBeforeRepeat);

      const claudeProfilePath = resolve(fixture.home, ".claude.json");
      const claudeProfile = await readFile(claudeProfilePath);
      await writeFile(claudeProfilePath, "{}", { mode: 0o600 });
      await expect(
        runProductionSetup(
          { clients: "none", credentialBackend: "not-selected" },
          new AbortController().signal,
          clientEnvironment,
          { pinnedInitialPolicySha256: sha256(policyBytes) },
        ),
      ).rejects.toThrow(/claude|integration|profile|registration/i);
      expect(
        await snapshotTree(resolve(fixture.xdgStateHome, "skillwire")),
      ).toEqual(stateBeforeRepeat);
      await writeFile(claudeProfilePath, claudeProfile, { mode: 0o600 });

      await unlink(
        resolve(
          fixture.stateRoot,
          "credentials",
          clientResult.installationId,
          "claude.key",
        ),
      );
      await expect(
        runProductionSetup(
          { clients: "none", credentialBackend: "not-selected" },
          new AbortController().signal,
          clientEnvironment,
          { pinnedInitialPolicySha256: sha256(policyBytes) },
        ),
      ).rejects.toThrow(/credential|bridge|unavailable/i);
      expect(
        await snapshotTree(resolve(fixture.xdgStateHome, "skillwire")),
      ).toEqual(stateBeforeRepeat);
    },
    360_000,
  );
});
