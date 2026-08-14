import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import {
  CODEX_ADAPTER_SOURCE_PATH,
  CODEX_ADAPTER_VALIDATOR_VERSION,
  CODEX_MANAGER_VERSION,
  CodexAdapterValidationError,
  SKILLWIRE_PLUGIN_SOURCE_GIT_URL,
  createCodexAdapterIntegrityManifest,
  validateCodexAdapterPackage,
} from "../src/evaluation/codex-adapter-package.js";

interface Arguments {
  readonly command: "validate" | "manifest";
  readonly pluginRoot: string;
  readonly sourceCommit?: string;
}

function main(): void {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.command === "validate") {
      const report = validateCodexAdapterPackage(args.pluginRoot);
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          pluginName: report.pluginName,
          pluginVersion: report.pluginVersion,
          adapterPolicyVersion: report.adapterPolicyVersion,
          dependencyUrlSha256: createHash("sha256")
            .update(report.dependencyUrl)
            .digest("hex"),
          fileCount: report.files.length,
          packageSha256: report.packageSha256,
          validatorVersion: CODEX_ADAPTER_VALIDATOR_VERSION,
          managerVersion: CODEX_MANAGER_VERSION,
        })}\n`,
      );
      return;
    }
    if (args.sourceCommit === undefined) {
      throw new CodexAdapterValidationError(["SOURCE_COMMIT_REQUIRED"]);
    }
    const manifest = createCodexAdapterIntegrityManifest(args.pluginRoot, {
      sourceUrl: SKILLWIRE_PLUGIN_SOURCE_GIT_URL,
      sourcePath: CODEX_ADAPTER_SOURCE_PATH,
      sourceCommit: args.sourceCommit,
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } catch (error) {
    const codes =
      error instanceof CodexAdapterValidationError
        ? error.codes
        : ["INVALID_ARGUMENT"];
    process.stderr.write(`${JSON.stringify({ ok: false, codes })}\n`);
    process.exitCode = 1;
  }
}

function parseArguments(argv: readonly string[]): Arguments {
  const command = argv[0];
  if (command !== "validate" && command !== "manifest") {
    throw new CodexAdapterValidationError(["INVALID_COMMAND"]);
  }
  let pluginRoot = join(
    process.cwd(),
    "integrations/codex/skillwire-autonomous-activation",
  );
  let sourceCommit: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--plugin-root" && value !== undefined) {
      pluginRoot = resolve(value);
      index += 1;
    } else if (option === "--source-commit" && value !== undefined) {
      sourceCommit = value;
      index += 1;
    } else {
      throw new CodexAdapterValidationError(["INVALID_ARGUMENT"]);
    }
  }
  return {
    command,
    pluginRoot,
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
  };
}

main();
