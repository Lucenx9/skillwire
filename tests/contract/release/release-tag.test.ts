import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifySelfHostedReleaseTag } from "../../../scripts/verify-self-hosted-release-tag.js";
import { releaseManifestFixture } from "../../helpers/self-hosted-release-fixtures.js";

const roots = new Set<string>();

function git(root: string, ...args: readonly string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      `safe.directory=${root}`,
      "-c",
      "user.name=SkillWire Release Test",
      "-c",
      "user.email=release-test@invalid.example",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
}

async function releaseRepository(): Promise<{
  readonly root: string;
  readonly commit: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "skillwire-release-tag-"));
  roots.add(root);
  git(root, "init", "--initial-branch=main");
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "skillwire", version: "0.2.0" })}\n`,
  );
  git(root, "add", "package.json");
  git(root, "commit", "-m", "release source");
  const commit = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", commit);
  return { root, commit };
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true })));
  roots.clear();
});

describe("self-hosted release tag", () => {
  it("pins the authoritative project version to 0.2.0", async () => {
    const packageDocument = JSON.parse(
      await readFile("package.json", "utf8"),
    ) as { version?: string };
    expect(packageDocument.version).toBe("0.2.0");
  });

  it("accepts the exact annotated tag recursively peeled to the workflow SHA", async () => {
    const fixture = await releaseRepository();
    git(
      fixture.root,
      "tag",
      "--annotate",
      "self-hosted-v0.2.0",
      "--message",
      "SkillWire Self-Hosted v0.2.0",
      fixture.commit,
    );

    await expect(
      verifySelfHostedReleaseTag({
        repositoryRoot: fixture.root,
        githubRef: "refs/tags/self-hosted-v0.2.0",
        githubSha: fixture.commit,
      }),
    ).resolves.toEqual({
      packageVersion: "0.2.0",
      tagRef: "refs/tags/self-hosted-v0.2.0",
      targetCommit: fixture.commit,
    });

    expect(() =>
      execFileSync(
        process.execPath,
        [
          resolve("scripts/verify-self-hosted-release-tag.ts"),
          "--repository",
          fixture.root,
          "--ref",
          "refs/tags/self-hosted-v0.2.0",
          "--sha",
          fixture.commit,
        ],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  it("rejects a lightweight tag", async () => {
    const fixture = await releaseRepository();
    git(fixture.root, "tag", "self-hosted-v0.2.0", fixture.commit);

    await expect(
      verifySelfHostedReleaseTag({
        repositoryRoot: fixture.root,
        githubRef: "refs/tags/self-hosted-v0.2.0",
        githubSha: fixture.commit,
      }),
    ).rejects.toThrow(/annotated/i);
  });

  it.each([
    "refs/tags/self-hosted-v0.1.0",
    "refs/tags/v0.2.0",
    "refs/tags/self-hosted-v0.2",
    "refs/tags/self-hosted-v0.2.0-extra",
  ])("rejects stale, generic, or malformed ref %s", async (githubRef) => {
    const fixture = await releaseRepository();
    const tagName = githubRef.slice("refs/tags/".length);
    git(
      fixture.root,
      "tag",
      "--annotate",
      tagName,
      "--message",
      "invalid release tag",
      fixture.commit,
    );

    await expect(
      verifySelfHostedReleaseTag({
        repositoryRoot: fixture.root,
        githubRef,
        githubSha: fixture.commit,
      }),
    ).rejects.toThrow(/package version|release ref/i);
  });

  it("rejects a tag that does not peel to GITHUB_SHA", async () => {
    const fixture = await releaseRepository();
    git(
      fixture.root,
      "tag",
      "--annotate",
      "self-hosted-v0.2.0",
      "--message",
      "SkillWire Self-Hosted v0.2.0",
      fixture.commit,
    );
    const differentSha = "f".repeat(40);

    await expect(
      verifySelfHostedReleaseTag({
        repositoryRoot: fixture.root,
        githubRef: "refs/tags/self-hosted-v0.2.0",
        githubSha: differentSha,
      }),
    ).rejects.toThrow(/workflow SHA/i);
  });

  it("rejects a manifest whose version or source commit disagrees with the tag", async () => {
    const fixture = await releaseRepository();
    git(
      fixture.root,
      "tag",
      "--annotate",
      "self-hosted-v0.2.0",
      "--message",
      "SkillWire Self-Hosted v0.2.0",
      fixture.commit,
    );
    const manifestPath = join(fixture.root, "release.json");
    const manifest = releaseManifestFixture({
      releaseVersion: "0.2.0",
      sourceCommit: "e".repeat(40),
      signatureBundles: [
        {
          signerId: "github-release-primary",
          path: "skillwire-0.2.0-linux-amd64.release.sigstore.json",
        },
      ],
      archive: {
        ...releaseManifestFixture().archive,
        path: "skillwire-0.2.0-linux-amd64.tar.zst",
      },
    });
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(
      verifySelfHostedReleaseTag({
        repositoryRoot: fixture.root,
        githubRef: "refs/tags/self-hosted-v0.2.0",
        githubSha: fixture.commit,
        manifestPath,
      }),
    ).rejects.toThrow(/manifest version or source commit/i);
  });

  it("rejects an annotated tag whose target is not reachable from protected main", async () => {
    const fixture = await releaseRepository();
    git(fixture.root, "switch", "--orphan", "unmerged-release");
    await writeFile(
      join(fixture.root, "package.json"),
      `${JSON.stringify({ name: "skillwire", version: "0.2.0" })}\n`,
    );
    await writeFile(join(fixture.root, "unmerged.txt"), "unmerged\n");
    git(fixture.root, "add", "package.json", "unmerged.txt");
    git(fixture.root, "commit", "-m", "unmerged release");
    const unmergedCommit = git(fixture.root, "rev-parse", "HEAD");
    git(
      fixture.root,
      "tag",
      "--annotate",
      "self-hosted-v0.2.0",
      "--message",
      "SkillWire Self-Hosted v0.2.0",
      unmergedCommit,
    );

    await expect(
      verifySelfHostedReleaseTag({
        repositoryRoot: fixture.root,
        githubRef: "refs/tags/self-hosted-v0.2.0",
        githubSha: unmergedCommit,
      }),
    ).rejects.toThrow(/protected main/i);
  });
});
