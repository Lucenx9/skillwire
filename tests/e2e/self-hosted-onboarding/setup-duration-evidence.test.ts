import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { recordSetupDuration } from "../../../src/onboarding/application/setup-duration.js";

describe("informational clean-host setup duration", () => {
  it("records elapsed time and environment identity without a pass/fail threshold", async () => {
    const started = performance.now();
    await Promise.resolve();
    const evidence = recordSetupDuration({
      startedMilliseconds: started,
      endedMilliseconds: performance.now(),
      environment: "disposable-simulated-clean-host",
      result: "completed",
      sourceCommit: "1".repeat(40),
      manifestSha256: "2".repeat(64),
    });
    expect(evidence).toMatchObject({
      schemaVersion: "skillwire.setup-duration/v1",
      gating: false,
      environment: "disposable-simulated-clean-host",
      result: "completed",
      sourceCommit: "1".repeat(40),
      manifestSha256: "2".repeat(64),
    });
    expect(evidence.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(evidence)).not.toMatch(/threshold|passed|failed/i);
  });
});
