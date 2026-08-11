export interface Clock {
  now(): Date;
  monotonicMilliseconds(): number;
}

export const systemClock: Clock = Object.freeze({
  now: () => new Date(),
  monotonicMilliseconds: () => performance.now(),
});
