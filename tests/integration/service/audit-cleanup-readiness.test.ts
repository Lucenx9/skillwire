import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditCleanupScheduler } from "../../../src/lifecycle/audit-cleanup-scheduler.js";
import { ReadinessState } from "../../../src/lifecycle/readiness-state.js";

describe("audit cleanup lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("completes startup cleanup before readiness", async () => {
    const cleanup = vi.fn<() => Promise<number>>().mockResolvedValue(2);
    const readiness = new ReadinessState();
    const scheduler = new AuditCleanupScheduler(cleanup, readiness);

    expect(readiness.isReady()).toBe(false);
    await scheduler.start();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(readiness.isReady()).toBe(true);
    scheduler.stop();
  });

  it("becomes unready after hourly failure and ready after a successful retry", async () => {
    vi.useFakeTimers();
    const cleanup = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(0);
    const readiness = new ReadinessState();
    const scheduler = new AuditCleanupScheduler(cleanup, readiness, 3_600_000);
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(readiness.isReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(readiness.isReady()).toBe(true);
    scheduler.stop();
  });
});
