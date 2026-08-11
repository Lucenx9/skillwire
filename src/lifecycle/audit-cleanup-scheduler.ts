import type { ReadinessState } from "./readiness-state.js";

const ONE_HOUR_MILLISECONDS = 3_600_000;

export class AuditCleanupScheduler {
  private interval: NodeJS.Timeout | undefined;
  private cleanupRunning = false;

  public constructor(
    private readonly cleanup: () => Promise<number>,
    private readonly readiness: ReadinessState,
    private readonly intervalMilliseconds = ONE_HOUR_MILLISECONDS,
  ) {}

  private async runCleanup(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      await this.cleanup();
      this.readiness.markReady();
    } catch (error) {
      this.readiness.markNotReady();
      throw error;
    } finally {
      this.cleanupRunning = false;
    }
  }

  public async start(): Promise<void> {
    if (this.interval !== undefined) return;
    this.readiness.markNotReady();
    await this.runCleanup();
    this.interval = setInterval(() => {
      this.runCleanup().catch(() => {
        // Readiness carries the bounded externally observable failure state.
      });
    }, this.intervalMilliseconds);
    this.interval.unref();
  }

  public stop(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
    this.readiness.markNotReady();
  }
}
