import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadActivationFixtures,
  validateActivationFixtures,
  validateActivationTrace,
} from "../../../src/evaluation/activation-corpus-runner.js";

const projectRoot = process.cwd();

describe("frozen autonomous-activation corpus", () => {
  it("keeps the contract constants and cohort minima explicit", () => {
    const schema = JSON.parse(
      readFileSync(
        join(
          projectRoot,
          "specs/003-autonomous-skill-activation/contracts/activation-corpus.schema.json",
        ),
        "utf8",
      ),
    ) as {
      properties: {
        schemaVersion: { const: number };
        corpusId: { const: string };
        policyVersion: { const: string };
        cases: { minItems: number; allOf: { minContains: number }[] };
      };
    };

    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(schema.properties.corpusId.const).toBe("autonomous-activation-v1");
    expect(schema.properties.policyVersion.const).toBe(
      "skillwire-activation-v1",
    );
    expect(schema.properties.cases.minItems).toBe(60);
    expect(
      schema.properties.cases.allOf.map((rule) => rule.minContains),
    ).toEqual([25, 15, 10, 10, 5]);
  });

  it("validates immutable checksums and all semantic fixture links", () => {
    const fixtures = loadActivationFixtures(projectRoot);
    const validated = validateActivationFixtures(fixtures);

    expect(validated.corpus.cases).toHaveLength(75);
    expect(validated.cohortCounts).toEqual({
      automaticRelevant: 40,
      irrelevant: 15,
      userRequestedExplicit: 10,
      userRequestedWithoutIntent: 10,
      localOverlap: 5,
    });
    expect(new Set(validated.corpus.cases.map(({ id }) => id)).size).toBe(75);
    expect(validated.pairIds).toHaveLength(10);
    expect(validated.catalog.skills).toHaveLength(11);
    expect(validated.localInventory.entries).toHaveLength(5);

    for (const entry of validated.manifest.files) {
      expect(
        createHash("sha256")
          .update(fixtures.sourceText.get(entry.path) ?? "")
          .digest("hex"),
      ).toBe(entry.sha256);
    }
  });

  it("rejects in-place mutation, broken pairs, and unresolved resources", () => {
    const mutated = loadActivationFixtures(projectRoot);
    mutated.sourceText.set(
      "evaluation/autonomous-activation.v1.json",
      `${mutated.sourceText.get("evaluation/autonomous-activation.v1.json") ?? ""}\n`,
    );
    expect(() => validateActivationFixtures(mutated)).toThrow(
      /checksum mismatch/i,
    );

    const brokenPair = loadActivationFixtures(projectRoot);
    const paired = brokenPair.corpus as {
      cases: { pairId?: string; scenarioClass: string }[];
    };
    const withoutIntent = paired.cases.find(
      ({ scenarioClass }) => scenarioClass === "user-requested-without-intent",
    );
    delete withoutIntent?.pairId;
    expect(() => validateActivationFixtures(brokenPair)).toThrow();

    const unresolved = loadActivationFixtures(projectRoot);
    const corpus = unresolved.corpus as {
      cases: {
        expectedBehavior: {
          resourcePaths: string[];
          operationSequence: string[];
          maxResourceCalls: number;
        };
      }[];
    };
    const resourceCase = corpus.cases.find(
      ({ expectedBehavior }) => expectedBehavior.resourcePaths.length > 0,
    );
    resourceCase?.expectedBehavior.resourcePaths.push("references/missing.md");
    resourceCase?.expectedBehavior.operationSequence.push(
      "read_skill_resource",
    );
    if (resourceCase !== undefined) {
      resourceCase.expectedBehavior.maxResourceCalls += 1;
    }
    expect(() => validateActivationFixtures(unresolved)).toThrow(
      /declared resource/i,
    );
  });

  it("contains only bounded, privacy-safe prompt and trace expectations", () => {
    const { corpus } = validateActivationFixtures(
      loadActivationFixtures(projectRoot),
    );

    for (const activationCase of corpus.cases) {
      expect(activationCase.prompt).not.toMatch(
        /(?:api[_-]?key|authorization:|bearer\s+|-----BEGIN|\/home\/|[A-Z]:\\)/i,
      );
      expect(
        activationCase.expectedBehavior.maxSearchCalls,
      ).toBeLessThanOrEqual(1);
      expect(activationCase.expectedBehavior.maxLoadCalls).toBeLessThanOrEqual(
        1,
      );
      expect(new Set(activationCase.expectedBehavior.resourcePaths).size).toBe(
        activationCase.expectedBehavior.resourcePaths.length,
      );
      expect(activationCase.expectedBehavior.operationSequence).toEqual([
        ...(activationCase.expectedBehavior.search === "call"
          ? ["search_skills"]
          : []),
        ...(activationCase.expectedBehavior.load === "call"
          ? ["load_skill"]
          : []),
        ...activationCase.expectedBehavior.resourcePaths.map(
          () => "read_skill_resource",
        ),
      ]);
    }
  });

  it.each([
    {
      name: "repeated or reformulated search",
      expectedCode: "REPEATED_SEARCH",
      events: [
        {
          taskIntent: "intent-a",
          toolName: "search_skills",
          result: "success",
          summaryFingerprint: "a".repeat(64),
        },
        {
          taskIntent: "intent-a",
          toolName: "search_skills",
          result: "success",
          summaryFingerprint: "b".repeat(64),
        },
      ],
    },
    {
      name: "polling after an empty result",
      expectedCode: "CALL_AFTER_TERMINAL",
      events: [
        {
          taskIntent: "intent-a",
          toolName: "search_skills",
          result: "empty",
        },
        {
          taskIntent: "intent-a",
          toolName: "search_skills",
          result: "success",
        },
      ],
    },
    {
      name: "second candidate load",
      expectedCode: "SECOND_LOAD",
      events: [
        {
          taskIntent: "intent-a",
          toolName: "search_skills",
          result: "success",
        },
        {
          taskIntent: "intent-a",
          toolName: "load_skill",
          result: "success",
          skillId: "typescript-code-review",
          revision: "1.0.0",
        },
        {
          taskIntent: "intent-a",
          toolName: "load_skill",
          result: "success",
          skillId: "threat-modeling",
          revision: "1.0.0",
        },
      ],
    },
    {
      name: "duplicate resource path",
      expectedCode: "DUPLICATE_RESOURCE",
      events: [
        {
          taskIntent: "intent-a",
          toolName: "search_skills",
          result: "success",
        },
        {
          taskIntent: "intent-a",
          toolName: "load_skill",
          result: "success",
          skillId: "typescript-code-review",
          revision: "1.0.0",
        },
        {
          taskIntent: "intent-a",
          toolName: "read_skill_resource",
          result: "success",
          path: "references/review-checklist.md",
        },
        {
          taskIntent: "intent-a",
          toolName: "read_skill_resource",
          result: "success",
          path: "references/review-checklist.md",
        },
      ],
    },
    {
      name: "retry after error",
      expectedCode: "CALL_AFTER_TERMINAL",
      events: [
        {
          taskIntent: "intent-a",
          toolName: "search_skills",
          result: "error",
        },
        {
          taskIntent: "intent-a",
          toolName: "load_skill",
          result: "success",
          skillId: "typescript-code-review",
          revision: "1.0.0",
        },
      ],
    },
  ])("rejects $name", ({ events, expectedCode }) => {
    const result = validateActivationTrace(events);
    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain(expectedCode);
  });

  it("starts a fresh bounded attempt for materially new task intent", () => {
    expect(
      validateActivationTrace([
        {
          taskIntent: "intent-a",
          toolName: "search_skills",
          result: "empty",
        },
        {
          taskIntent: "intent-b",
          toolName: "search_skills",
          result: "success",
        },
      ]),
    ).toEqual({ valid: true, reasonCodes: [] });
  });
});
