import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPairedActivationEvidenceFixture } from "../../helpers/paired-activation-evidence.js";

const projectRoot = process.cwd();
const cli = join(projectRoot, "scripts", "activation-evidence.ts");
const tsx = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const fixture = (name: string) =>
  join(projectRoot, "tests", "fixtures", "activation", name);

function run(
  command: "validate" | "summarize" | "validate-pair" | "summarize-pair",
  input: string,
) {
  return spawnSync(process.execPath, [tsx, cli, command, "--input", input], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://forbidden.invalid/skillwire",
      SKILLWIRE_GITHUB_INGESTION_ENABLED: "false",
    },
  });
}

describe("activation evidence CLI", () => {
  let temporaryRoot: string;
  let validPair: string;
  let invalidPair: string;

  beforeAll(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "skillwire-paired-cli-"));
    validPair = join(temporaryRoot, "valid-pair.json");
    invalidPair = join(temporaryRoot, "invalid-pair.json");
    const valid = createPairedActivationEvidenceFixture(projectRoot);
    writeFileSync(validPair, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
    valid.adapter.sourceCommit = "0".repeat(40);
    writeFileSync(invalidPair, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
  });

  afterAll(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it.each(["validate", "summarize"] as const)(
    "%s emits stable privacy-safe JSON for valid evidence",
    (command) => {
      const result = run(command, fixture("manual-evidence-valid.v1.json"));

      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toMatchObject({
        valid: true,
        evidenceId: "activation-valid-v1",
        status: "complete",
      });
      expect(JSON.stringify(output)).not.toMatch(
        /(?:Review strict TypeScript|repositoryHash|\/home\/|authorization|bearer|skill content)/i,
      );
    },
  );

  it("accepts incomplete evidence and labels it without positive denominators", () => {
    const result = run(
      "summarize",
      fixture("manual-evidence-incomplete.v1.json"),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      status: "incomplete",
      metrics: { spontaneousActivation: { denominator: 0 } },
    });
  });

  it("returns a safe nonzero schema failure", () => {
    const result = run("validate", fixture("manual-evidence-invalid.v1.json"));

    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: false,
      errors: ["EVIDENCE_SCHEMA_INVALID"],
    });
    expect(result.stdout).not.toContain("privacy-leak");
  });

  it.each(["validate-pair", "summarize-pair"] as const)(
    "%s emits stable privacy-safe JSON for an attributable pair",
    (command) => {
      const result = run(command, validPair);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        valid: true,
        evidencePairId: "paired-activation-fixture-v1",
        status: "complete",
        claimEligibility: { eligible: true, evaluatedRelevantCases: 8 },
      });
      expect(result.stdout).not.toMatch(
        /(?:authorization|bearer|api[_-]?key|\/home\/|repositoryHash|raw prompt|skill content)/i,
      );
    },
  );

  it("returns safe nonzero pair schema, reference-shape, and release failures", () => {
    const wrongShape = run(
      "validate-pair",
      fixture("manual-evidence-valid.v1.json"),
    );
    expect(wrongShape.status).not.toBe(0);
    expect(JSON.parse(wrongShape.stdout)).toEqual({
      valid: false,
      errors: ["PAIRED_EVIDENCE_SCHEMA_INVALID"],
    });

    const invalid = run("validate-pair", invalidPair);
    expect(invalid.status).not.toBe(0);
    const invalidOutput: unknown = JSON.parse(invalid.stdout);
    expect(invalidOutput).toMatchObject({
      valid: false,
    });
    expect(invalid.stdout).toContain('"ADAPTER_RELEASE_MISMATCH"');
    expect(invalid.stdout).not.toMatch(/(?:\/tmp\/|credential|token)/i);
  });
});
