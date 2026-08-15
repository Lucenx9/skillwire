import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SEMVER = /^\d+\.\d+\.\d+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const MAXIMUM_JSON_BYTES = 16 * 1024 * 1024;

export interface SelfHostedReleaseTagOptions {
  readonly repositoryRoot: string;
  readonly githubRef: string;
  readonly githubSha: string;
  readonly manifestPath?: string | undefined;
}

export interface VerifiedSelfHostedReleaseTag {
  readonly packageVersion: string;
  readonly tagRef: string;
  readonly targetCommit: string;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function requireCommitSha(value: string, label: string): string {
  if (!COMMIT_SHA.test(value)) throw new Error(`${label} must be a commit SHA`);
  return value;
}

async function readBoundedJson(path: string): Promise<Record<string, unknown>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAXIMUM_JSON_BYTES)
      throw new Error("Release identity JSON must be a bounded regular file");
    return requireRecord(
      JSON.parse(await handle.readFile("utf8")) as unknown,
      "Release identity JSON",
    );
  } finally {
    await handle.close();
  }
}

async function git(
  repositoryRoot: string,
  args: readonly string[],
  acceptExitCodes: readonly number[] = [0],
): Promise<{ readonly code: number; readonly stdout: string }> {
  try {
    const result = await execFileAsync(
      "/usr/bin/git",
      ["-c", `safe.directory=${repositoryRoot}`, "-C", repositoryRoot, ...args],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      },
    );
    return { code: 0, stdout: result.stdout.trim() };
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? Number(error.code)
        : -1;
    if (acceptExitCodes.includes(code)) return { code, stdout: "" };
    throw new Error("Release tag Git verification failed", { cause: error });
  }
}

export async function verifySelfHostedReleaseTag(
  options: SelfHostedReleaseTagOptions,
): Promise<VerifiedSelfHostedReleaseTag> {
  if (!isAbsolute(options.repositoryRoot))
    throw new Error("Release repository root must be absolute");
  const repositoryRoot = resolve(options.repositoryRoot);
  const githubSha = requireCommitSha(options.githubSha, "Workflow SHA");
  const packageDocument = requireRecord(
    JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as unknown,
    "Package document",
  );
  if (
    typeof packageDocument["version"] !== "string" ||
    !SEMVER.test(packageDocument["version"])
  )
    throw new Error("Package version must be an exact semantic version");

  const expectedRef = `refs/tags/self-hosted-v${packageDocument["version"]}`;
  if (options.githubRef !== expectedRef)
    throw new Error(
      "Self-hosted release ref does not match the package version",
    );

  const objectType = await git(repositoryRoot, [
    "cat-file",
    "-t",
    options.githubRef,
  ]);
  if (objectType.stdout !== "tag")
    throw new Error("Self-hosted releases require an annotated tag object");

  const peeled = requireCommitSha(
    (
      await git(repositoryRoot, [
        "rev-parse",
        "--verify",
        `${options.githubRef}^{commit}`,
      ])
    ).stdout,
    "Annotated tag target",
  );
  if (peeled !== githubSha)
    throw new Error("Annotated tag target does not match the workflow SHA");

  const reachable = await git(
    repositoryRoot,
    ["merge-base", "--is-ancestor", peeled, "refs/remotes/origin/main"],
    [0, 1],
  );
  if (reachable.code !== 0)
    throw new Error("Release tag target is not reachable from protected main");

  if (options.manifestPath !== undefined) {
    const manifest = await readBoundedJson(options.manifestPath);
    if (
      manifest["releaseVersion"] !== packageDocument["version"] ||
      manifest["sourceCommit"] !== githubSha
    ) {
      throw new Error(
        "Release manifest version or source commit does not match the annotated tag",
      );
    }
  }

  return {
    packageVersion: packageDocument["version"],
    tagRef: expectedRef,
    targetCommit: peeled,
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const repositoryRoot = argument("--repository");
  const githubRef = argument("--ref");
  const githubSha = argument("--sha");
  if (
    repositoryRoot === undefined ||
    githubRef === undefined ||
    githubSha === undefined
  ) {
    throw new Error(
      "Usage: verify-self-hosted-release-tag --repository <absolute-path> --ref <ref> --sha <commit> [--manifest <path>]",
    );
  }
  await verifySelfHostedReleaseTag({
    repositoryRoot,
    githubRef,
    githubSha,
    manifestPath: argument("--manifest"),
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : "Release tag verification failed";
    process.stderr.write(`${message.replaceAll(/[\r\n]/g, " ")}\n`);
    process.exitCode = 1;
  });
}
