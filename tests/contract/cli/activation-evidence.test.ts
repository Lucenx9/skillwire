import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const cli = join(projectRoot, "scripts", "activation-evidence.ts");
const tsx = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const fixture = (name: string) =>
  join(projectRoot, "tests", "fixtures", "activation", name);

function run(command: "validate" | "summarize", input: string) {
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
});
