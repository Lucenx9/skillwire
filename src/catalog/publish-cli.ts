import { existsSync } from "node:fs";
import { join } from "node:path";

import { publishCatalog } from "./catalog-publisher.js";

interface Arguments {
  readonly releaseId: string;
  readonly genesis: boolean;
  readonly previousReleaseCommit: string | null;
  readonly publishedAt?: string | undefined;
}

function parseArguments(args: readonly string[]): Arguments {
  let releaseId: string | undefined;
  let genesis = false;
  let previousReleaseCommit: string | undefined;
  let publishedAt: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--genesis") {
      genesis = true;
      continue;
    }
    if (
      argument === "--release-id" ||
      argument === "--previous-release-commit" ||
      argument === "--published-at"
    ) {
      const value = args[index + 1];
      if (value === undefined) throw new Error("INVALID_INPUT");
      if (argument === "--release-id") releaseId = value;
      else if (argument === "--previous-release-commit")
        previousReleaseCommit = value;
      else publishedAt = value;
      index += 1;
      continue;
    }
    throw new Error("INVALID_INPUT");
  }
  if (
    releaseId === undefined ||
    genesis === (previousReleaseCommit !== undefined) ||
    (previousReleaseCommit !== undefined &&
      !/^[0-9a-f]{40}$/.test(previousReleaseCommit)) ||
    (publishedAt !== undefined && Number.isNaN(Date.parse(publishedAt)))
  ) {
    throw new Error("INVALID_INPUT");
  }
  return {
    releaseId,
    genesis,
    previousReleaseCommit: previousReleaseCommit ?? null,
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

function failedResult() {
  return {
    releaseId: null,
    created: false,
    releasePath: null,
    revisions: [],
    errors: ["INVALID_INPUT"],
  };
}

let parsed: Arguments;
try {
  parsed = parseArguments(process.argv.slice(2));
} catch {
  process.stdout.write(`${JSON.stringify(failedResult())}\n`);
  process.exit(1);
}

const projectRoot = process.env["SKILLWIRE_ROOT"] ?? process.cwd();
const injectedFault =
  process.env["NODE_ENV"] === "test"
    ? process.env["SKILLWIRE_TEST_PUBLISH_FAULT"]
    : undefined;
const result = publishCatalog({
  projectRoot,
  releaseId: parsed.releaseId,
  genesis: parsed.genesis,
  previousReleaseCommit: parsed.previousReleaseCommit,
  publishedAt: parsed.publishedAt,
  faultInjection:
    injectedFault === undefined
      ? undefined
      : (point) => {
          if (point === injectedFault) throw new Error("injected fault");
        },
});
if (
  result.created &&
  existsSync(join(projectRoot, "catalog", "releases", ".publish-claim"))
) {
  process.stderr.write("PUBLICATION_CLAIM_REMAINS\n");
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.created ? 0 : 1;
