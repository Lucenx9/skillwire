import { isAbsolute, resolve } from "node:path";

import {
  EvidenceValidationError,
  loadActivationEvidence,
  validateActivationEvidence,
} from "../src/evaluation/activation-evidence.js";

interface Arguments {
  readonly command: "validate" | "summarize";
  readonly input: string;
}

function parseArguments(args: readonly string[]): Arguments {
  const command = args[0];
  if (command !== "validate" && command !== "summarize") {
    throw new EvidenceValidationError(["INVALID_ARGUMENT"]);
  }
  if (args[1] !== "--input" || args[2] === undefined || args.length !== 3) {
    throw new EvidenceValidationError(["INVALID_ARGUMENT"]);
  }
  return {
    command,
    input: isAbsolute(args[2]) ? args[2] : resolve(process.cwd(), args[2]),
  };
}

function main(): void {
  const arguments_ = parseArguments(process.argv.slice(2));
  const report = validateActivationEvidence(
    loadActivationEvidence(arguments_.input),
    process.cwd(),
  );
  process.stdout.write(
    `${JSON.stringify({
      valid: true,
      evidenceId: report.evidenceId,
      status: report.status,
      observationCount: report.observationCount,
      diagnosticCodes: report.diagnosticCodes,
      ...(arguments_.command === "summarize"
        ? { metrics: report.metrics }
        : {}),
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  const errors =
    error instanceof EvidenceValidationError
      ? error.codes
      : ["EVIDENCE_VALIDATION_FAILED"];
  process.stdout.write(`${JSON.stringify({ valid: false, errors })}\n`);
  process.exitCode = 1;
}
