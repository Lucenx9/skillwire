import { z } from "zod";

const SetupDurationEvidenceSchema = z
  .object({
    schemaVersion: z.literal("skillwire.setup-duration/v1"),
    gating: z.literal(false),
    environment: z.string().min(1).max(160),
    result: z.enum(["completed", "incomplete", "cancelled"]),
    elapsedMilliseconds: z.number().nonnegative(),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type SetupDurationEvidence = z.infer<typeof SetupDurationEvidenceSchema>;

export function recordSetupDuration(options: {
  readonly startedMilliseconds: number;
  readonly endedMilliseconds: number;
  readonly environment: string;
  readonly result: SetupDurationEvidence["result"];
  readonly sourceCommit: string;
  readonly manifestSha256: string;
}): SetupDurationEvidence {
  if (
    !Number.isFinite(options.startedMilliseconds) ||
    !Number.isFinite(options.endedMilliseconds) ||
    options.endedMilliseconds < options.startedMilliseconds
  ) {
    throw new Error("Setup duration observation is invalid");
  }
  return SetupDurationEvidenceSchema.parse({
    schemaVersion: "skillwire.setup-duration/v1",
    gating: false,
    environment: options.environment,
    result: options.result,
    sourceCommit: options.sourceCommit,
    manifestSha256: options.manifestSha256,
    elapsedMilliseconds:
      options.endedMilliseconds - options.startedMilliseconds,
  });
}
