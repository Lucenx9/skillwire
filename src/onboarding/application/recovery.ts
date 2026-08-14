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

function requireActiveRecovery(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Recovery cancelled");
}

function unresolvedEffectBoundaries(
  entries: readonly JournalEntry[],
): readonly JournalEntry[] {
  const unresolved = new Map<string, JournalEntry>();
  for (const entry of entries) {
    if (entry.phase === "effect") unresolved.set(entry.step, entry);
    else if (entry.phase === "compensate") {
      if (entry.detail["completion"] === "unproven")
        unresolved.set(entry.step, entry);
      else unresolved.delete(entry.step);
    } else if (entry.phase === "commit") unresolved.clear();
  }
  return [...unresolved.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function journalNeedsRecovery(
  entries: readonly JournalEntry[],
): boolean {
  const last = entries.at(-1);
  if (last === undefined || last.phase === "commit") return false;
  if (last.phase !== "cancel") return true;
  if (last.detail["status"] === "recovery-required") return true;
  return unresolvedEffectBoundaries(entries).length > 0;
}

async function reconcileEffectBoundaries(options: {
  readonly journal: OperationJournal;
  readonly signal: AbortSignal;
  readonly observe: (step: string) => Promise<RecoveryObservation>;
  readonly compensate: (step: string) => Promise<void>;
  readonly boundaries: readonly JournalEntry[];
}): Promise<RecoveryResult> {
  const observations: {
    readonly boundary: JournalEntry;
    readonly observation: Exclude<RecoveryObservation, "ambiguous">;
  }[] = [];
  for (const boundary of [...options.boundaries].reverse()) {
    const observation = await options.observe(boundary.step);
    requireActiveRecovery(options.signal);
    if (observation === "ambiguous")
      return {
        disposition: "recovery-required",
        changed: false,
        boundary: boundary.step,
      };
    observations.push({ boundary, observation });
  }

  for (const { boundary, observation } of observations) {
    if (observation === "owned-mismatch")
      await options.compensate(boundary.step);
    await options.journal.compensate(boundary.step, {
      completion: observation === "absent" ? "not-started" : "recovered",
      recoveryRequired: false,
      observation,
    });
  }
  await options.journal.commit({ status: "recovered" });
  const mostRecent = options.boundaries.at(-1);
  return {
    disposition: observations.every(
      ({ observation }) => observation === "absent",
    )
      ? "safe-retry"
      : "resume",
    changed: true,
    boundary: mostRecent?.step ?? null,
  };
}

export async function recoverOperation(options: {
  readonly journal: OperationJournal;
  readonly signal: AbortSignal;
  readonly observe: (step: string) => Promise<RecoveryObservation>;
  readonly compensate: (step: string) => Promise<void>;
}): Promise<RecoveryResult> {
  requireActiveRecovery(options.signal);
  const last = options.journal.entries.at(-1);
  if (last === undefined)
    return { disposition: "safe-retry", changed: false, boundary: null };
  if (last.phase === "commit")
    return {
      disposition: "complete",
      changed: false,
      boundary: last.step,
    };

  const unresolved = unresolvedEffectBoundaries(options.journal.entries);
  if (unresolved.length > 0)
    return reconcileEffectBoundaries({ ...options, boundaries: unresolved });

  if (last.phase === "cancel")
    return last.detail["status"] === "recovery-required"
      ? {
          disposition: "recovery-required",
          changed: false,
          boundary: last.step,
        }
      : {
          disposition: "safe-retry",
          changed: false,
          boundary: last.step,
        };

  if (last.phase === "intent") {
    const observation = await options.observe(last.step);
    requireActiveRecovery(options.signal);
    if (observation === "ambiguous")
      return {
        disposition: "recovery-required",
        changed: false,
        boundary: last.step,
      };
    if (observation === "matching") {
      await options.journal.effect(last.step, { completion: "recovered" });
      await options.journal.verify(last.step, { recovered: true });
      await options.journal.commit({ status: "recovered" });
      return {
        disposition: "resume",
        changed: true,
        boundary: last.step,
      };
    }
    if (observation === "owned-mismatch") await options.compensate(last.step);
    await options.journal.compensate(last.step, {
      completion: observation === "absent" ? "not-started" : "recovered",
      recoveryRequired: false,
      observation,
    });
    await options.journal.commit({ status: "recovered" });
    return {
      disposition: observation === "absent" ? "safe-retry" : "resume",
      changed: true,
      boundary: last.step,
    };
  }

  if (last.phase === "verify" || last.phase === "compensate") {
    await options.journal.commit({ status: "recovered" });
    return {
      disposition: "resume",
      changed: false,
      boundary: last.step,
    };
  }

  return { disposition: "safe-retry", changed: false, boundary: null };
}
