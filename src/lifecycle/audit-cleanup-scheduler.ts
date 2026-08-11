import type { ReadinessState } from "./readiness-state.js";

const ONE_HOUR_MILLISECONDS = 3_600_000;

export class AuditCleanupScheduler {
  private interval: NodeJS.Timeout | undefined;
  private cleanupRunning: Promise<void> | undefined;
  private started = false;

  public constructor(
    private readonly cleanup: () => Promise<number>,
    private readonly readiness: ReadinessState,
    private readonly intervalMilliseconds = ONE_HOUR_MILLISECONDS,
    private readonly probeDatabase: () => Promise<void> = () =>
      Promise.resolve(),
  ) {}

  private async runCleanup(): Promise<void> {
    if (this.cleanupRunning !== undefined) return this.cleanupRunning;
    const running = (async () => {
      try {
        await this.cleanup();
        if (this.started) this.readiness.markReady();
      } catch (error) {
        this.readiness.markNotReady();
        throw error;
      }
    })();
    this.cleanupRunning = running;
    try {
      await running;
    } finally {
      if (this.cleanupRunning === running) this.cleanupRunning = undefined;
    }
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.readiness.markNotReady();
    try {
      await this.runCleanup();
    } catch (error) {
      this.started = false;
      throw error;
    }
    this.interval = setInterval(() => {
      this.runCleanup().catch(() => {
        // Readiness carries the bounded externally observable failure state.
      });
    }, this.intervalMilliseconds);
    this.interval.unref();
  }

  public async checkReadiness(): Promise<boolean> {
    if (!this.started) return false;
    try {
      await this.probeDatabase();
    } catch {
      this.readiness.markNotReady();
      return false;
    }
    if (!this.readiness.isReady()) {
      try {
        await this.runCleanup();
      } catch {
        return false;
      }
    }
    return this.readiness.isReady();
  }

  public stop(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
    this.started = false;
    this.readiness.markNotReady();
  }
}
