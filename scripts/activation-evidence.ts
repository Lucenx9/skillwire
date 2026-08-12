import { isAbsolute, resolve } from "node:path";

import {
  EvidenceValidationError,
  loadActivationEvidence,
  loadPairedActivationEvidence,
  validateActivationEvidence,
  validatePairedActivationEvidence,
} from "../src/evaluation/activation-evidence.js";

interface Arguments {
  readonly command:
    "validate" | "summarize" | "validate-pair" | "summarize-pair";
  readonly input: string;
}

function parseArguments(args: readonly string[]): Arguments {
  const command = args[0];
  if (
    command !== "validate" &&
    command !== "summarize" &&
    command !== "validate-pair" &&
    command !== "summarize-pair"
  ) {
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
  if (
    arguments_.command === "validate-pair" ||
    arguments_.command === "summarize-pair"
  ) {
    const report = validatePairedActivationEvidence(
      loadPairedActivationEvidence(arguments_.input),
      process.cwd(),
    );
    process.stdout.write(
      `${JSON.stringify({
        valid: true,
        evidencePairId: report.evidencePairId,
        status: report.status,
        claimEligibility: report.claimEligibility,
        serverOnly: {
          status: report.serverOnly.status,
          observationCount: report.serverOnly.observationCount,
          ...(arguments_.command === "summarize-pair"
            ? { metrics: report.serverOnly.metrics }
            : {}),
        },
        adapter: {
          status: report.adapter.status,
          observationCount: report.adapter.observationCount,
          ...(arguments_.command === "summarize-pair"
            ? { metrics: report.adapter.metrics }
            : {}),
        },
      })}\n`,
    );
    return;
  }
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
