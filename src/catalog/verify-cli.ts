import { verifyCatalog } from "./catalog-verifier.js";

interface Arguments {
  readonly releaseId: string;
  readonly github: boolean;
}

function parseArguments(args: readonly string[]): Arguments {
  let releaseId: string | undefined;
  let github = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--github") {
      github = true;
      continue;
    }
    if (argument === "--release-id") {
      releaseId = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error("INVALID_INPUT");
  }
  if (
    releaseId === undefined ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(releaseId)
  ) {
    throw new Error("INVALID_INPUT");
  }
  return { releaseId, github };
}

function failedResult() {
  return {
    releaseId: "invalid",
    valid: false,
    checks: {
      inventory: false,
      release: false,
      publicationClaimAbsent: false,
      advisoryChain: false,
      githubBaseline: false,
      baselineMode: "genesis",
      previousReleaseCommit: null,
      selectedGitHubReleaseId: null,
      selectedGitHubPublishedAt: null,
      resolvedPreviousReleaseCommit: null,
    },
    revisions: [],
    errors: ["INVALID_INPUT"],
  };
}

async function main(): Promise<void> {
  let parsed: Arguments;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch {
    process.stdout.write(`${JSON.stringify(failedResult())}\n`);
    process.exitCode = 1;
    return;
  }
  const projectRoot = process.env["SKILLWIRE_ROOT"] ?? process.cwd();
  const result = await verifyCatalog(projectRoot, parsed.releaseId, {
    requireGitHubBaseline: parsed.github,
    repository: process.env["GITHUB_REPOSITORY"],
    token: process.env["GITHUB_TOKEN"],
    apiUrl: process.env["GITHUB_API_URL"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.valid ? 0 : 1;
}

await main();
