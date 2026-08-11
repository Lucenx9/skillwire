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

  it("actively probes the database and cleans once before recovered readiness", async () => {
    let databaseAvailable = true;
    const cleanup = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    const readiness = new ReadinessState();
    const scheduler = new AuditCleanupScheduler(
      cleanup,
      readiness,
      3_600_000,
      () =>
        databaseAvailable
          ? Promise.resolve()
          : Promise.reject(new Error("database unavailable")),
    );
    await scheduler.start();

    databaseAvailable = false;
    await expect(scheduler.checkReadiness()).resolves.toBe(false);
    expect(readiness.isReady()).toBe(false);

    databaseAvailable = true;
    await expect(
      Promise.all([scheduler.checkReadiness(), scheduler.checkReadiness()]),
    ).resolves.toEqual([true, true]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("coalesces concurrent recovery cleanup", async () => {
    let releaseCleanup: (() => void) | undefined;
    const cleanup = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            releaseCleanup = () => {
              resolve(0);
            };
          }),
      );
    const readiness = new ReadinessState();
    const scheduler = new AuditCleanupScheduler(cleanup, readiness);
    await scheduler.start();
    readiness.markNotReady();

    const checks = [scheduler.checkReadiness(), scheduler.checkReadiness()];
    await vi.waitFor(() => {
      expect(cleanup).toHaveBeenCalledTimes(2);
    });
    releaseCleanup?.();

    await expect(Promise.all(checks)).resolves.toEqual([true, true]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
