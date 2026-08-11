import type { Clock } from "../../src/application/ports/clock.js";

export class FixedClock implements Clock {
  public constructor(
    private current: Date,
    private monotonic = 0,
  ) {}

  public now(): Date {
    return new Date(this.current);
  }

  public monotonicMilliseconds(): number {
    return this.monotonic;
  }

  public advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("Clock advance must be a nonnegative finite value");
    }
    this.current = new Date(this.current.getTime() + milliseconds);
    this.monotonic += milliseconds;
  }
}
