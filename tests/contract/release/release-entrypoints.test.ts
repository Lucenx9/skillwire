import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import {
  RELEASE_PAYLOAD_FILES,
  releasePayloadMode,
} from "../../helpers/self-hosted-release-fixtures.js";

interface PackageFile {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly version?: string;
}

const implementations = {
  "build:self-hosted": "scripts/build-self-hosted-release.ts",
  "verify:self-hosted": "scripts/verify-self-hosted-release.ts",
} as const;

function packageFile(): PackageFile {
  return JSON.parse(
    readFileSync(resolve("package.json"), "utf8"),
  ) as PackageFile;
}

function runPackageCommand(
  command: keyof typeof implementations,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve(implementations[command]),
      ...args,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        HOME: "/nonexistent",
        PATH: process.env["PATH"],
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        CI: "1",
        ...environment,
      },
      timeout: 60_000,
    },
  );
}

function runSourceCli(args: readonly string[], environment: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("src/onboarding/cli/main.ts"),
      ...args,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...environment, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      timeout: 60_000,
    },
  );
}

describe("public self-hosted release entrypoints", () => {
  let fixture: OnboardingEnvironment | undefined;

  afterEach(async () => fixture?.close());

  it("publishes one tracked package command for each normative release entrypoint", () => {
    const packageJson = packageFile();
    expect(packageJson.scripts?.["build:self-hosted"]).toBe(
      "tsx scripts/build-self-hosted-release.ts",
    );
    expect(packageJson.scripts?.["verify:self-hosted"]).toBe(
      "tsx scripts/verify-self-hosted-release.ts",
    );

    for (const implementation of Object.values(implementations)) {
      expect(
        readFileSync(resolve(implementation), "utf8").length,
      ).toBeGreaterThan(0);
      if (existsSync(resolve(".git"))) {
        expect(
          execFileSync(
            "/usr/bin/git",
            [
              "-c",
              `safe.directory=${process.cwd()}`,
              "ls-files",
              "--error-unmatch",
              implementation,
            ],
            {
              encoding: "utf8",
            },
          ).trim(),
        ).toBe(implementation);
      }
    }

    const quickstart = readFileSync(
      resolve("specs/004-self-hosted-onboarding/quickstart.md"),
      "utf8",
    );
    const readme = readFileSync(
      resolve("distribution/self-hosted/README.md"),
      "utf8",
    );
    const releaseContract = readFileSync(
      resolve(
        "specs/004-self-hosted-onboarding/contracts/release-and-recovery.md",
      ),
      "utf8",
    );
    const workflow = readFileSync(
      resolve(".github/workflows/self-hosted-release.yml"),
      "utf8",
    );
    for (const source of [quickstart, readme, releaseContract, workflow]) {
      expect(source).not.toContain("pnpm build:self-hosted --");
      expect(source).not.toContain("pnpm verify:self-hosted --");
    }
    expect(quickstart).toContain("pnpm build:self-hosted \\");
    expect(quickstart).toContain("pnpm verify:self-hosted \\");
    expect(readme).toContain("pnpm verify:self-hosted \\");
    expect(releaseContract).toContain("pnpm build:self-hosted <payload-root>");
    expect(releaseContract).toContain("pnpm verify:self-hosted \\");
    expect(workflow).toContain("pnpm build:self-hosted \\");
    expect(workflow).toContain("pnpm verify:self-hosted \\");
  });

  it.each([
    ["build:self-hosted", "Usage: build-self-hosted-release"],
    ["verify:self-hosted", "Usage: verify-self-hosted-release"],
  ] as const)(
    "starts %s help without production credentials",
    (command, usage) => {
      const result = runPackageCommand(command, ["--help"]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(usage);
      expect(result.stderr).toBe("");
    },
  );

  it("keeps unsigned reproducibility separate from signed-asset verification", () => {
    const quickstart = readFileSync(
      resolve("specs/004-self-hosted-onboarding/quickstart.md"),
      "utf8",
    );
    const buildIndex = quickstart.indexOf("pnpm build:self-hosted \\");
    const verifyIndex = quickstart.indexOf("pnpm verify:self-hosted \\");
    expect(buildIndex).toBeGreaterThan(0);
    expect(verifyIndex).toBeGreaterThan(buildIndex);
    const buildPrelude = quickstart.slice(0, buildIndex);
    for (const input of [
      "SW004_PAYLOAD_ROOT",
      "SW004_RELEASE_IMAGES_JSON",
      "SW004_RELEASE_SEQUENCE",
      "SW004_PUBLISHED_AT",
      "SW004_SOURCE_COMMIT",
    ]) {
      expect(buildPrelude).toContain(`\${${input}:?`);
    }
    const verification = quickstart.slice(
      verifyIndex,
      quickstart.indexOf("```", verifyIndex),
    );
    expect(verification).toContain("$SW004_SIGNED_ASSET_ROOT/");
    expect(verification).not.toContain("$SW004_RELEASE_OUTPUT/");
    expect(quickstart).toContain(
      "The unsigned output is never an input to production verification",
    );
  });

  it("builds the same unsigned canonical outputs without signing or publishing", async () => {
    fixture = await createOnboardingEnvironment();
    const payload = resolve(fixture.root, "payload");
    for (const [path, contents] of Object.entries(RELEASE_PAYLOAD_FILES)) {
      const target = resolve(payload, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, contents, { mode: releasePayloadMode(path) });
      await chmod(target, releasePayloadMode(path));
    }
    const environment = {
      HOME: fixture.home,
      SKILLWIRE_RELEASE_IMAGES_JSON: JSON.stringify([
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
      ]),
      SKILLWIRE_RELEASE_VERSION: "0.2.0",
      SKILLWIRE_RELEASE_SEQUENCE: "17",
      SKILLWIRE_PUBLISHED_AT: "2026-08-15T00:00:00.000Z",
      GITHUB_SHA: "1".repeat(40),
      SKILLWIRE_TRUST_SEQUENCE: "1",
    };
    const outputs = [
      resolve(fixture.root, "release-a"),
      resolve(fixture.root, "release-b"),
    ];
    for (const output of outputs) {
      const result = runPackageCommand(
        "build:self-hosted",
        [payload, output, "amd64"],
        environment,
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect((await readdir(output)).toSorted()).toEqual([
        "skillwire-0.2.0-linux-amd64.release.json",
        "skillwire-0.2.0-linux-amd64.tar.zst",
      ]);
    }
    const firstOutput = outputs[0];
    const secondOutput = outputs[1];
    if (firstOutput === undefined || secondOutput === undefined) {
      throw new Error("two deterministic release outputs are required");
    }
    for (const filename of await readdir(firstOutput)) {
      expect(await readFile(resolve(firstOutput, filename))).toEqual(
        await readFile(resolve(secondOutput, filename)),
      );
    }
  });

  it("fails closed when a release asset, signature, or trust input is absent", async () => {
    fixture = await createOnboardingEnvironment();
    const inputs = [
      ["--manifest", resolve(fixture.root, "release.json")],
      ["--bundle", resolve(fixture.root, "release.sigstore.json")],
      ["--archive", resolve(fixture.root, "release.tar.zst")],
      ["--policy", resolve(fixture.root, "trust-policy.json")],
      ["--trusted-root", resolve(fixture.root, "trusted-root.json")],
      ["--cosign", resolve(fixture.root, "cosign")],
      ["--architecture", "amd64"],
    ] as const;
    for (const missing of [
      "--manifest",
      "--bundle",
      "--policy",
      "--trusted-root",
    ]) {
      const args = inputs
        .filter(([flag]) => flag !== missing)
        .flatMap(([flag, value]) => [flag, value]);
      const result = runPackageCommand("verify:self-hosted", args, {
        HOME: fixture.home,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(12);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage: verify-self-hosted-release");
      expect(result.stderr).not.toContain('verified":true');
    }

    const missingFiles = runPackageCommand(
      "verify:self-hosted",
      inputs.flatMap(([flag, value]) => [flag, value]),
      { HOME: fixture.home },
    );
    expect(missingFiles.error).toBeUndefined();
    expect(missingFiles.status).toBe(12);
    expect(missingFiles.stdout).toBe("");
    expect(missingFiles.stderr).not.toContain('verified":true');
  });

  it("does not make unsigned source-checkout setup available", async () => {
    fixture = await createOnboardingEnvironment();
    const before = await readdir(fixture.xdgDataHome);
    const result = runSourceCli(
      ["setup", "--clients", "codex", "--preview-only", "--output", "json"],
      fixture.environment,
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(12);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      command: "setup",
      status: "failure",
      exitClass: "release-integrity-failure",
      changed: false,
    });
    expect(await readdir(fixture.xdgDataHome)).toEqual(before);
  });
});
