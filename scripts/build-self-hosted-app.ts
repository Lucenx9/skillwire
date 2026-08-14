import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "../src/onboarding/adapters/process/command-runner.js";

export interface BuildSelfHostedApplicationOptions {
  readonly esbuildExecutable: string;
  readonly entrypoint: string;
  readonly output: string;
}

const NODE_ESM_REQUIRE_BANNER =
  'import { createRequire as __skillwireCreateRequire } from "node:module"; const require = __skillwireCreateRequire(import.meta.url);';

export async function buildSelfHostedApplication(
  options: BuildSelfHostedApplicationOptions,
): Promise<void> {
  if (
    !isAbsolute(options.esbuildExecutable) ||
    !isAbsolute(options.entrypoint) ||
    !isAbsolute(options.output) ||
    !options.output.endsWith(".mjs")
  ) {
    throw new Error(
      "Self-hosted application paths must be absolute and output must be .mjs",
    );
  }
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
  await runCommand({
    executable: options.esbuildExecutable,
    args: [
      options.entrypoint,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      `--banner:js=${NODE_ESM_REQUIRE_BANNER}`,
      `--outfile=${options.output}`,
    ],
    environment: { PATH: "/usr/bin:/bin", LANG: "C" },
    deadlineMilliseconds: 60_000,
    maximumOutputBytes: 64 * 1024,
  });
  await chmod(options.output, 0o644);
}

async function main(): Promise<void> {
  const [esbuildExecutable, entrypoint, output] = process.argv.slice(2);
  if (
    esbuildExecutable === undefined ||
    entrypoint === undefined ||
    output === undefined
  ) {
    throw new Error(
      "Usage: build-self-hosted-app <esbuild> <entrypoint> <output.mjs>",
    );
  }
  await buildSelfHostedApplication({ esbuildExecutable, entrypoint, output });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Application build failed"}\n`,
    );
    process.exitCode = 1;
  });
}
