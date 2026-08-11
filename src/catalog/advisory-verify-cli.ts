import { loadPublishedCatalog } from "./catalog-loader.js";
import { verifyGitHubReleaseBaseline } from "./github-release-baseline.js";

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

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const projectRoot = process.env["SKILLWIRE_ROOT"] ?? process.cwd();
  const loaded = loadPublishedCatalog(projectRoot, parsed.releaseId);
  let githubBaseline = null;
  if (parsed.github) {
    const repository = process.env["GITHUB_REPOSITORY"];
    const token = process.env["GITHUB_TOKEN"];
    if (repository === undefined || token === undefined) {
      throw new Error("GITHUB_BASELINE_UNAVAILABLE");
    }
    githubBaseline = await verifyGitHubReleaseBaseline({
      projectRoot,
      release: loaded.release,
      repository,
      token,
      apiUrl: process.env["GITHUB_API_URL"],
    });
  }
  process.stdout.write(
    `${JSON.stringify({
      releaseId: parsed.releaseId,
      valid: true,
      advisoryChainHead: loaded.advisoryChain.head,
      eventCount: loaded.advisoryChain.events.length,
      githubBaseline,
    })}\n`,
  );
}

main().catch(() => {
  process.stdout.write(
    `${JSON.stringify({ valid: false, errors: ["ADVISORY_VERIFICATION_FAILED"] })}\n`,
  );
  process.exitCode = 1;
});
