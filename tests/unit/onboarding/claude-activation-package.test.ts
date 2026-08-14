import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Claude instruction-only activation package", () => {
  it("contains only one manifest and one inert activation skill with no MCP/hook/credential payload", () => {
    const root = resolve("integrations/claude/skillwire-autonomous-activation");
    const manifestPath = resolve(root, ".claude-plugin/plugin.json");
    const skillPath = resolve(
      root,
      "skills/autonomous-skill-activation/SKILL.md",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const skill = readFileSync(skillPath, "utf8");
    expect(manifest).toMatchObject({
      name: "skillwire-autonomous-activation",
      version: "0.1.0",
    });
    expect(skill).toContain("search_skills");
    expect(skill).toContain("fail open");
    expect(skill).toContain("at most one minimal");
    expect(skill).toContain("load at most one exact");
    expect(skill).toContain("Do not retry, reformulate, poll");
    expect(skill).toContain("expand context");
    expect(skill).not.toMatch(/fallback to GitHub/i);
    expect(`${JSON.stringify(manifest)}\n${skill}`).not.toMatch(
      /\.mcp\.json|hooks|Bearer|swk\.|api[_-]?key/i,
    );
    const entries = readdirSync(root, { recursive: true })
      .map(String)
      .filter((path) => lstatSync(resolve(root, path)).isFile())
      .sort();
    expect(entries).toEqual([
      ".claude-plugin/plugin.json",
      "skills/autonomous-skill-activation/SKILL.md",
    ]);
    const marketplace = JSON.parse(
      readFileSync(
        resolve(
          "distribution/claude-marketplace/.claude-plugin/marketplace.json",
        ),
        "utf8",
      ),
    ) as { name: string; plugins: unknown[] };
    expect(marketplace.name).toBe("skillwire");
    expect(marketplace.plugins).toHaveLength(1);
  });

  it("keeps the self-contained release-local marketplace package byte-identical", () => {
    for (const path of [
      ".claude-plugin/plugin.json",
      "skills/autonomous-skill-activation/SKILL.md",
    ]) {
      expect(
        readFileSync(
          resolve(
            "distribution/claude-marketplace/plugins/skillwire-autonomous-activation",
            path,
          ),
        ),
      ).toEqual(
        readFileSync(
          resolve("integrations/claude/skillwire-autonomous-activation", path),
        ),
      );
    }
  });
});
