import { AsyncLocalStorage } from "node:async_hooks";

import { SkillWireError } from "./errors.js";

export interface RequestExecution {
  readonly signal?: AbortSignal | undefined;
  readonly deadline?: number | undefined;
}

const requestExecutionStorage = new AsyncLocalStorage<RequestExecution>();

export function runWithRequestExecution<Result>(
  execution: RequestExecution,
  operation: () => Result,
): Result {
  return requestExecutionStorage.run(execution, operation);
}

export function assertCurrentRequestActive(): void {
  const execution = requestExecutionStorage.getStore();
  if (execution !== undefined) assertRequestActive(execution);
}

export function assertRequestActive(execution: RequestExecution): void {
  if (
    execution.signal?.aborted === true ||
    (execution.deadline !== undefined && Date.now() >= execution.deadline)
  ) {
    throw new SkillWireError("INTERNAL");
  }
}

export function requestTimeRemaining(execution: RequestExecution): number {
  if (execution.deadline === undefined) return 0;
  return Math.max(0, Math.ceil(execution.deadline - Date.now()));
}
