import { publishCatalog } from "./catalog-publisher.js";
import { verifyCatalog } from "./catalog-verifier.js";

type Command = "publish" | "verify";

interface ParsedArguments {
  readonly releaseId: string;
  readonly genesis: boolean;
  readonly publishedAt?: string | undefined;
}

function parseArguments(
  command: Command,
  args: readonly string[],
): ParsedArguments {
  let releaseId: string | undefined;
  let genesis = false;
  let publishedAt: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--genesis") {
      genesis = true;
      continue;
    }
    if (argument === "--release-id" || argument === "--published-at") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("INVALID_INPUT");
      if (argument === "--release-id") releaseId = value;
      else publishedAt = value;
      index += 1;
      continue;
    }
    throw new Error("INVALID_INPUT");
  }
  if (releaseId === undefined || (command === "publish" && !genesis)) {
    throw new Error("INVALID_INPUT");
  }
  if (command === "verify" && (genesis || publishedAt !== undefined)) {
    throw new Error("INVALID_INPUT");
  }
  if (publishedAt !== undefined && Number.isNaN(Date.parse(publishedAt))) {
    throw new Error("INVALID_INPUT");
  }
  return {
    releaseId,
    genesis,
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

function fail(command: Command): never {
  const output =
    command === "publish"
      ? {
          releaseId: null,
          created: false,
          releasePath: null,
          revisions: [],
          errors: ["INVALID_INPUT"],
        }
      : {
          releaseId: "invalid",
          valid: false,
          checks: {
            inventory: false,
            release: false,
            publicationClaimAbsent: false,
          },
          revisions: [],
          errors: ["INVALID_INPUT"],
        };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(1);
}

const command = process.argv[2];
if (command !== "publish" && command !== "verify") {
  process.stderr.write("Expected catalog subcommand publish or verify\n");
  process.exit(1);
}

let parsed: ParsedArguments;
try {
  parsed = parseArguments(command, process.argv.slice(3));
} catch {
  fail(command);
}

const projectRoot = process.env["SKILLWIRE_ROOT"] ?? process.cwd();
const result =
  command === "publish"
    ? publishCatalog({
        projectRoot,
        releaseId: parsed.releaseId,
        publishedAt: parsed.publishedAt,
      })
    : verifyCatalog(projectRoot, parsed.releaseId);

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode =
  "created" in result ? (result.created ? 0 : 1) : result.valid ? 0 : 1;
