import { describe, expect, it } from "vitest";

import {
  evaluateActivationCorpus,
  loadActivationFixtures,
  validateActivationFixtures,
} from "../../src/evaluation/activation-corpus-runner.js";
import { validateCodexAdapterPackage } from "../../src/evaluation/codex-adapter-package.js";
import {
  createActivationMcpHarness,
  type RecordedToolCall,
} from "../helpers/activation-mcp-harness.js";
import { join } from "node:path";

describe("frozen autonomous-activation evaluation", () => {
  it("deterministically resolves catalog matches and context filtering", () => {
    const fixtures = validateActivationFixtures(
      loadActivationFixtures(process.cwd()),
    );
    const result = evaluateActivationCorpus(fixtures);

    expect(result.caseCount).toBe(75);
    expect(result.catalogMatchFailures).toEqual([]);
    expect(result.traceExpectationFailures).toEqual([]);
    expect(result.userRequestedIsolation).toEqual({
      numerator: 10,
      denominator: 10,
      rate: 1,
    });
    expect(result.zeroMatch).toEqual({
      numerator: 15,
      denominator: 15,
      rate: 1,
    });
    expect(result.progressiveResourceCases).toBeGreaterThan(0);
  });

  it("reports clean, local-overlap, and failure cohorts separately", () => {
    const result = evaluateActivationCorpus(
      validateActivationFixtures(loadActivationFixtures(process.cwd())),
    );

    expect(result.cohorts.cleanAutomatic.caseIds).toHaveLength(30);
    expect(result.cohorts.localOverlap.caseIds).toHaveLength(5);
    expect(result.cohorts.failure.caseIds).toHaveLength(5);
    expect(result.cohorts.irrelevant.caseIds).toHaveLength(15);
    expect(result.cohorts.userRequestedExplicit.caseIds).toHaveLength(10);
    expect(result.cohorts.userRequestedWithoutIntent.caseIds).toHaveLength(10);
    expect(
      result.cohorts.cleanAutomatic.caseIds.some((id) =>
        result.cohorts.localOverlap.caseIds.includes(id),
      ),
    ).toBe(false);
  });

  it("preserves every bounded expected operation sequence and failure category", () => {
    const result = evaluateActivationCorpus(
      validateActivationFixtures(loadActivationFixtures(process.cwd())),
    );

    expect(result.cases.every(({ traceValid }) => traceValid)).toBe(true);
    expect(result.failureCounts).toEqual({
      "authentication-failed": 1,
      "no-relevant-result": 1,
      "rate-limited": 1,
      "resource-failed": 1,
      "revision-unavailable": 1,
      "service-unavailable": 1,
    });
  });

  it("conforms adapter guidance to actual attributable MCP sequences for every clean relevant case", async () => {
    const fixtures = validateActivationFixtures(
      loadActivationFixtures(process.cwd()),
    );
    const adapter = validateCodexAdapterPackage(
      join(process.cwd(), "integrations/codex/skillwire-autonomous-activation"),
    );
    const allNonOverlap = fixtures.corpus.cases.filter(
      (entry) =>
        entry.scenarioClass === "automatic-relevant" &&
        entry.localSkillFixture === undefined,
    );
    const cases = allNonOverlap.filter(
      ({ failureMode }) => failureMode === undefined,
    );
    const failureCases = allNonOverlap.filter(
      ({ failureMode }) => failureMode !== undefined,
    );
    const harness = await createActivationMcpHarness({
      protocol: "modern",
      maxToolCalls: 80,
    });

    try {
      expect(adapter.semanticChecks.oneAutomaticSearch).toBe(true);
      expect(adapter.semanticChecks.exactVerifiedLoad).toBe(true);
      expect(allNonOverlap).toHaveLength(35);
      expect(cases).toHaveLength(30);
      expect(failureCases).toHaveLength(5);
      expect(
        failureCases.every(
          ({ expectedBehavior }) =>
            expectedBehavior.maxSearchCalls <= 1 &&
            expectedBehavior.maxLoadCalls <= 1,
        ),
      ).toBe(true);

      for (const activationCase of cases) {
        const expected = activationCase.expectedCatalogMatch;
        if (expected === null)
          throw new Error("Expected immutable catalog match");
        const start = harness.toolCalls.length;
        const searched = await harness.callTool("search_skills", {
          task: activationCase.prompt,
          invocationContext: "automatic",
          limit: 1,
        });
        const preview = firstSearchPreview(searched.structuredContent);
        expect(preview).toEqual({
          skillId: expected.skillId,
          revision: expected.revision,
        });

        const loaded = await harness.callTool("load_skill", {
          skillId: preview.skillId,
          revision: preview.revision,
        });
        expect(loadIdentity(loaded.structuredContent)).toEqual(expected);

        for (const resourcePath of activationCase.expectedBehavior
          .resourcePaths) {
          const resource = await harness.callTool("read_skill_resource", {
            skillId: preview.skillId,
            revision: preview.revision,
            path: resourcePath,
          });
          expect(resource.isError).not.toBe(true);
        }

        const actual = harness.toolCalls.slice(start).map(({ name }) => name);
        expect(actual).toEqual(
          activationCase.expectedBehavior.operationSequence,
        );
        expect(isAttributableActivation(harness.toolCalls.slice(start))).toBe(
          true,
        );
      }

      expect(isAttributableActivation([])).toBe(false);
      await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
      expect(harness.githubRequestCount).toBe(0);
    } finally {
      await harness.close();
    }
  });
});

function firstSearchPreview(value: unknown): {
  skillId: string;
  revision: string;
} {
  if (!isRecord(value)) {
    throw new Error("Search response missing structured content");
  }
  const skills = value["skills"];
  if (!Array.isArray(skills) || skills.length !== 1) {
    throw new Error("Search response missing one preview");
  }
  if (!isRecord(skills[0])) {
    throw new Error("Search response missing exact preview identity");
  }
  const skillId = skills[0]["skillId"];
  const revision = skills[0]["revision"];
  if (typeof skillId !== "string" || typeof revision !== "string") {
    throw new Error("Search response missing exact preview identity");
  }
  return { skillId, revision };
}

function loadIdentity(value: unknown): {
  skillId: string;
  revision: string;
  revisionSha256: string;
} {
  return identity(value);
}

function identity(value: unknown): {
  skillId: string;
  revision: string;
  revisionSha256: string;
} {
  if (!isRecord(value)) {
    throw new Error("Expected SkillWire identity");
  }
  const skillId = value["skillId"];
  const revision = value["revision"];
  const revisionSha256 = value["revisionSha256"];
  if (
    typeof skillId !== "string" ||
    typeof revision !== "string" ||
    typeof revisionSha256 !== "string"
  ) {
    throw new Error("Expected exact SkillWire identity fields");
  }
  return { skillId, revision, revisionSha256 };
}

function isAttributableActivation(calls: readonly RecordedToolCall[]): boolean {
  return calls[0]?.name === "search_skills" && calls[1]?.name === "load_skill";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
