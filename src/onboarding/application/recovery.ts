import type {
  JournalEntry,
  OperationJournal,
} from "../domain/operation-journal.js";

export type RecoveryObservation =
  "absent" | "matching" | "owned-mismatch" | "ambiguous";

export interface RecoveryResult {
  readonly disposition:
    "complete" | "safe-retry" | "resume" | "recovery-required";
  readonly changed: boolean;
  readonly boundary: string | null;
}

export function journalNeedsRecovery(
  entries: readonly JournalEntry[],
): boolean {
  const last = entries.at(-1);
  if (last === undefined || last.phase === "commit") return false;
  if (last.phase !== "cancel") return true;
  return last.detail["status"] === "recovery-required";
}

function lastEffectBoundary(
  entries: readonly JournalEntry[],
): JournalEntry | undefined {
  return [...entries]
    .reverse()
    .find(({ phase }) => phase === "intent" || phase === "effect");
}

export async function recoverOperation(options: {
  readonly journal: OperationJournal;
  readonly signal: AbortSignal;
  readonly observe: (step: string) => Promise<RecoveryObservation>;
  readonly compensate: (step: string) => Promise<void>;
}): Promise<RecoveryResult> {
  if (options.signal.aborted) throw new Error("Recovery cancelled");
  const last = options.journal.entries.at(-1);
  if (last === undefined)
    return { disposition: "safe-retry", changed: false, boundary: null };
  if (last.phase === "commit")
    return {
      disposition: "complete",
      changed: false,
      boundary: last.step,
    };
  if (
    last.phase === "cancel" &&
    last.detail["status"] === "recovery-required" &&
    options.journal.hasUnprovenEffect()
  ) {
    const unresolved = [...options.journal.entries]
      .reverse()
      .find(
        (entry) =>
          entry.phase === "compensate" &&
          entry.detail["completion"] === "unproven",
      );
    if (unresolved === undefined)
      return {
        disposition: "recovery-required",
        changed: false,
        boundary: last.step,
      };
    const observation = await options.observe(unresolved.step);
    if (observation === "ambiguous")
      return {
        disposition: "recovery-required",
        changed: false,
        boundary: unresolved.step,
      };
    if (observation === "owned-mismatch")
      await options.compensate(unresolved.step);
    await options.journal.compensate(unresolved.step, {
      completion: observation === "absent" ? "not-started" : "recovered",
      recoveryRequired: false,
    });
    await options.journal.commit({ status: "recovered" });
    return {
      disposition: observation === "absent" ? "safe-retry" : "resume",
      changed: true,
      boundary: unresolved.step,
    };
  }
  if (last.phase === "cancel" && !options.journal.hasUnprovenEffect())
    return {
      disposition: "safe-retry",
      changed: false,
      boundary: last.step,
    };
  if (last.phase === "intent") {
    await options.journal.compensate(last.step, {
      completion: "not-started",
      recoveryRequired: false,
    });
    await options.journal.commit({ status: "recovered" });
    return {
      disposition: "safe-retry",
      changed: true,
      boundary: last.step,
    };
  }
  if (last.phase === "compensate" && options.journal.hasUnprovenEffect()) {
    const observation = await options.observe(last.step);
    if (observation === "ambiguous")
      return {
        disposition: "recovery-required",
        changed: false,
        boundary: last.step,
      };
    if (observation === "owned-mismatch") await options.compensate(last.step);
    await options.journal.compensate(last.step, {
      completion: observation === "absent" ? "not-started" : "recovered",
      recoveryRequired: false,
    });
    await options.journal.commit({ status: "recovered" });
    return {
      disposition: observation === "absent" ? "safe-retry" : "resume",
      changed: true,
      boundary: last.step,
    };
  }
  if (last.phase === "verify" || last.phase === "compensate") {
    if (!options.journal.hasUnprovenEffect())
      await options.journal.commit({ status: "recovered" });
    return {
      disposition: options.journal.hasUnprovenEffect()
        ? "recovery-required"
        : "resume",
      changed: false,
      boundary: last.step,
    };
  }

  const boundary = lastEffectBoundary(options.journal.entries);
  if (boundary === undefined)
    return { disposition: "safe-retry", changed: false, boundary: null };
  const observation = await options.observe(boundary.step);
  if (observation === "ambiguous")
    return {
      disposition: "recovery-required",
      changed: false,
      boundary: boundary.step,
    };
  if (observation === "matching") {
    await options.journal.verify(boundary.step, { recovered: true });
    await options.journal.commit({ status: "recovered" });
    return {
      disposition: "resume",
      changed: true,
      boundary: boundary.step,
    };
  }
  if (observation === "owned-mismatch") {
    await options.compensate(boundary.step);
    await options.journal.compensate(boundary.step, {
      completion: "recovered",
      recoveryRequired: false,
    });
    await options.journal.commit({ status: "recovered" });
    return {
      disposition: "resume",
      changed: true,
      boundary: boundary.step,
    };
  }
  await options.journal.compensate(boundary.step, {
    completion: "not-started",
    recoveryRequired: false,
  });
  await options.journal.commit({ status: "recovered" });
  return {
    disposition: "safe-retry",
    changed: true,
    boundary: boundary.step,
  };
}
