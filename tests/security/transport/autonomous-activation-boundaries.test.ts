import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createActivationMcpHarness,
  type ActivationMcpHarness,
} from "../../helpers/activation-mcp-harness.js";

describe("autonomous-activation security boundaries", () => {
  const harnesses: ActivationMcpHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it("keeps the real agent-facing path at six tools, zero GitHub calls, and zero client writes", async () => {
    const harness = await createActivationMcpHarness({
      protocol: "modern",
      maxToolCalls: 3,
    });
    harnesses.push(harness);

    expect(
      (await harness.client.listTools()).tools.map(({ name }) => name),
    ).toEqual([
      "search_skills",
      "load_skill",
      "read_skill_resource",
      "list_repo_memory",
      "record_skill_outcome",
      "forget_repo_memory",
    ]);
    await harness.callTool("search_skills", {
      task: "TypeScript code review",
      invocationContext: "automatic",
      limit: 1,
    });

    expect(harness.githubRequestCount).toBe(0);
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });

  it("keeps activation paths free of execution, installation, and client-write primitives", () => {
    const paths = [
      "src/transport/mcp/activation-policy.ts",
      "src/transport/mcp/server-factory.ts",
      "src/transport/mcp/tool-adapters.ts",
      "src/application/use-cases/search-skills.ts",
      "src/application/use-cases/load-skill.ts",
      "src/application/use-cases/read-skill-resource.ts",
      "src/evaluation/activation-corpus-runner.ts",
    ];
    const source = paths
      .map((path) => readFileSync(join(process.cwd(), path), "utf8"))
      .join("\n");

    for (const forbidden of [
      "node:child_process",
      "node:vm",
      "execFile(",
      "execSync(",
      "spawn(",
      "eval(",
      "npm install",
      "pnpm install",
      "git clone",
      "writeFile(",
      "createWriteStream(",
      "api.github.com",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("keeps runtime source disconnected from Codex-managed and adapter distribution paths", () => {
    const sourceFiles = readdirSync(join(process.cwd(), "src"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(entry.parentPath, entry.name));

    for (const path of sourceFiles) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(
        /(?:from|import\s*)\s*(?:\([^)]*)?["'][^"']*(?:integrations\/codex|distribution\/codex-marketplace|\.codex|\.agents|plugins\/cache)[^"']*["']/,
      );
      expect(source).not.toMatch(
        /(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|cp|cpSync|rename|renameSync)\s*\([^\n]*(?:integrations\/codex|distribution\/codex-marketplace|\.codex|\.agents|CODEX_HOME|plugins\/cache)/,
      );
    }
  });

  it("keeps policy and evidence records free of private request content", () => {
    const source = [
      "src/transport/mcp/activation-policy.ts",
      "tests/fixtures/activation/manual-evidence-valid.v1.json",
      "tests/fixtures/activation/manual-evidence-incomplete.v1.json",
    ]
      .map((path) => readFileSync(join(process.cwd(), path), "utf8"))
      .join("\n");

    expect(source).not.toMatch(
      /(?:authorization:|bearer\s+|-----BEGIN|\/home\/|[A-Z]:\\|repositoryHash"|"prompt"|"taskSummary"|raw-api-key)/i,
    );
  });

  it("treats returned skill instructions as inert response data", async () => {
    const harness = await createActivationMcpHarness({ protocol: "legacy" });
    harnesses.push(harness);
    const loaded = await harness.callTool("load_skill", {
      skillId: "typescript-code-review",
      revision: "1.0.0",
    });

    expect(loaded.isError).not.toBe(true);
    expect(harness.toolCalls.map(({ name }) => name)).toEqual(["load_skill"]);
    expect(harness.githubRequestCount).toBe(0);
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });
});
