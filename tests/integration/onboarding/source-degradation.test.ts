import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  bootstrapSources,
  sourceChoices,
} from "../../../src/onboarding/application/source-bootstrap.js";
import { degradedSourceProbe } from "../../../src/onboarding/application/diagnostic-probes.js";

describe("optional source degradation", () => {
  it.each([
    "GITHUB_RATE_LIMITED",
    "GITHUB_TRANSIENT",
    "SOURCE_NOT_PUBLIC",
    "SOURCE_REVOKED",
    "HASH_MISMATCH",
  ])(
    "isolates %s from first-party readiness and eligible cache",
    async (code) => {
      const sourceId = randomUUID();
      const results = await bootstrapSources(
        [
          {
            source: "mattpocock/skills",
            credentialReferenceId: randomUUID(),
          },
        ],
        {
          listRegistrations: () =>
            Promise.resolve([
              { sourceId, owner: "mattpocock", repository: "skills" },
            ]),
          register: () =>
            Promise.reject(new Error("registration must be reused")),
          synchronize: () => Promise.reject(new Error(code)),
        },
      );

      const result = results.at(0);
      expect(result).toMatchObject({
        syncState: "degraded",
        registrationIdentity: sourceId,
      });
      if (result === undefined) throw new Error("Missing source result");
      const finding = await degradedSourceProbe(result).run(
        new AbortController().signal,
      );
      expect(finding).toMatchObject({
        code: "SOURCE_SYNCHRONIZATION_DEGRADED",
        severity: "warning",
        component: "source",
      });
    },
  );

  it.each(["revoked", "quarantined", "verified", "curated"] as const)(
    "maps %s content through the existing eligibility boundary",
    async (classification) => {
      const sourceId = randomUUID();
      const choices = await bootstrapSources(
        [
          {
            source: "obra/superpowers",
            credentialReferenceId: randomUUID(),
          },
        ],
        {
          listRegistrations: () =>
            Promise.resolve([
              { sourceId, owner: "obra", repository: "superpowers" },
            ]),
          register: () => Promise.resolve({ sourceId, created: false }),
          synchronize: () =>
            Promise.resolve({
              sourceId,
              classifications: [classification],
              created: false,
            }),
        },
      );
      const choice = choices.find(
        ({ source }) => source === "obra/superpowers",
      );
      expect(choice?.syncState).toBe(
        classification === "verified" || classification === "curated"
          ? "eligible"
          : "quarantined",
      );
    },
  );

  it("reports a selected registration failure as a bounded source finding", async () => {
    const failed = sourceChoices([
      {
        source: "mattpocock/skills",
        credentialReferenceId: randomUUID(),
      },
    ]).find(({ selected }) => selected);
    if (failed === undefined) throw new Error("Missing failed source choice");
    await expect(
      degradedSourceProbe(failed).run(new AbortController().signal),
    ).resolves.toMatchObject({
      code: "SOURCE_SYNCHRONIZATION_DEGRADED",
      component: "source",
      severity: "warning",
    });
  });
});
