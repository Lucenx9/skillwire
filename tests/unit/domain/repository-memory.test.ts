import { describe, expect, it } from "vitest";

import {
  assertRepositoryHash,
  repositoryMemoryScope,
} from "../../../src/domain/repository-memory/types.js";
import {
  memoryBoostForOutcome,
  parseSkillOutcome,
} from "../../../src/domain/repository-memory/outcome.js";

const repositoryHash = "a".repeat(64);

describe("repository memory domain", () => {
  it("accepts only exact lowercase SHA-256 repository hashes", () => {
    expect(assertRepositoryHash(repositoryHash)).toBe(repositoryHash);
    for (const invalid of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      `${"a".repeat(63)}g`,
      ` ${repositoryHash}`,
    ]) {
      expect(() => assertRepositoryHash(invalid)).toThrow(/repository hash/i);
    }
  });

  it("constructs the account and repository tenant boundary", () => {
    expect(repositoryMemoryScope("account-1", repositoryHash)).toEqual({
      accountId: "account-1",
      repositoryHash,
    });
  });

  it("accepts exactly three replaceable outcomes", () => {
    expect(
      ["useful", "neutral", "unsuccessful"].map(parseSkillOutcome),
    ).toEqual(["useful", "neutral", "unsuccessful"]);
    expect(() => parseSkillOutcome("excellent")).toThrow(/outcome/i);
  });

  it("gives useful the larger bounded boost and unsuccessful no boost", () => {
    expect(memoryBoostForOutcome("useful")).toBeGreaterThan(
      memoryBoostForOutcome("neutral"),
    );
    expect(memoryBoostForOutcome("neutral")).toBe(memoryBoostForOutcome(null));
    expect(memoryBoostForOutcome("unsuccessful")).toBe(0);
  });
});
