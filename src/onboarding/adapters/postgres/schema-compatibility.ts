export interface SchemaUpgradeDecision {
  readonly kind: "same-schema" | "forward-only";
  readonly liveSchema: number;
  readonly targetSchema: number;
  readonly rollbackBoundary: "application-config" | "database-restore-required";
  readonly requiresBackup: true;
  readonly requiresWriterDrain: boolean;
}

export function classifySchemaUpgrade(input: {
  readonly liveSchema: number;
  readonly schemaMinimum: number;
  readonly schemaMaximum: number;
  readonly latestMigration: number;
  readonly forwardOnlyMigrations?: readonly number[] | undefined;
}): SchemaUpgradeDecision {
  if (
    !Number.isInteger(input.liveSchema) ||
    !Number.isInteger(input.schemaMinimum) ||
    !Number.isInteger(input.schemaMaximum) ||
    !Number.isInteger(input.latestMigration)
  )
    throw new Error("Schema compatibility values are invalid");
  if (
    input.liveSchema < input.schemaMinimum ||
    input.liveSchema > input.schemaMaximum
  )
    throw new Error("Live schema is incompatible with the target release");
  if (input.latestMigration < input.liveSchema)
    throw new Error("Schema downgrade is forbidden");
  if (input.latestMigration === input.liveSchema)
    return {
      kind: "same-schema",
      liveSchema: input.liveSchema,
      targetSchema: input.latestMigration,
      rollbackBoundary: "application-config",
      requiresBackup: true,
      requiresWriterDrain: false,
    };
  const migrations = Array.from(
    { length: input.latestMigration - input.liveSchema },
    (_, index) => input.liveSchema + index + 1,
  );
  const forwardOnly = new Set(input.forwardOnlyMigrations ?? [10, 11]);
  if (!migrations.some((migration) => forwardOnly.has(migration)))
    throw new Error("Unclassified forward migration is forbidden");
  return {
    kind: "forward-only",
    liveSchema: input.liveSchema,
    targetSchema: input.latestMigration,
    rollbackBoundary: "database-restore-required",
    requiresBackup: true,
    requiresWriterDrain: true,
  };
}
