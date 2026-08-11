import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { publicSkillId } from "../../../src/application/services/source-synchronization-service.js";

function suffix(path: string): string {
  return createHash("sha256")
    .update(path.normalize("NFC"))
    .digest("hex")
    .slice(0, 16);
}

describe("collision-safe imported public skill identifiers", () => {
  it("truncates only the readable prefix and retains the complete discriminator", () => {
    const path = "skills/very-long/SKILL.md";
    const id = publicSkillId(9_999_999_999, "a".repeat(120), path);
    expect(id).toHaveLength(80);
    expect(id.endsWith(`-${suffix(path)}`)).toBe(true);
  });

  it("separates same-source path collisions, cross-source identities, and normalized names", () => {
    const first = publicSkillId(42, "Café Skill", "a/SKILL.md");
    const normalized = publicSkillId(42, "Cafe\u0301 Skill", "b/SKILL.md");
    const deliberate = publicSkillId(42, "cafe-skill", "c/SKILL.md");
    const otherSource = publicSkillId(43, "Café Skill", "a/SKILL.md");
    expect(new Set([first, normalized, deliberate, otherSource]).size).toBe(4);
    expect(first).toMatch(/^gh-42-[a-z0-9-]+-[0-9a-f]{16}$/);
    expect(normalized.endsWith(`-${suffix("b/SKILL.md")}`)).toBe(true);
    expect(otherSource.startsWith("gh-43-")).toBe(true);
  });
});
