import { constants } from "node:fs";
import { open, mkdir, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const JournalPhaseSchema = z.enum([
  "intent",
  "effect",
  "verify",
  "compensate",
  "commit",
  "cancel",
]);
const JournalEntrySchema = z
  .object({
    sequence: z.number().int().positive(),
    timestamp: z.iso.datetime({ offset: true }),
    phase: JournalPhaseSchema,
    step: z.string().min(1).max(128),
    detail: z.record(
      z.string(),
      z.union([z.string().max(256), z.number(), z.boolean(), z.null()]),
    ),
  })
  .strict();

export const OperationRecordSchema = z
  .object({
    schemaVersion: z.literal("skillwire.operation/v1"),
    operationId: z.uuid(),
    installationId: z.uuid(),
    command: z.enum([
      "setup",
      "clients-install",
      "clients-uninstall",
      "clients-rotate-key",
      "repair",
      "backup",
      "upgrade",
      "rotate-service-secret",
      "uninstall",
      "purge",
    ]),
    previewHash: z.string().regex(/^[0-9a-f]{64}$/),
    state: z.enum([
      "previewed",
      "confirmed",
      "running",
      "compensating",
      "completed",
      "incomplete",
      "cancelled",
      "recovery-required",
      "failed",
    ]),
    rollbackBoundary: z.enum([
      "automatic",
      "client-only",
      "application-config",
      "database-restore-required",
      "none",
    ]),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export class OperationJournal {
  readonly entries: JournalEntry[] = [];

  private constructor(
    private readonly path: string,
    readonly operationId: string,
    readonly command: string,
  ) {}

  static async create(
    root: string,
    operationId: string,
    command: string,
  ): Promise<OperationJournal> {
    z.uuid().parse(operationId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = resolve(root, `${operationId}.jsonl`);
    const handle = await open(path, "wx", 0o600);
    await handle.sync();
    await handle.close();
    return new OperationJournal(path, operationId, command);
  }

  static async open(
    root: string,
    operationId: string,
    command: string,
  ): Promise<OperationJournal> {
    z.uuid().parse(operationId);
    const path = resolve(root, `${operationId}.jsonl`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size > 4 * 1024 * 1024
      ) {
        throw new Error("Operation journal is unsafe");
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const journal = new OperationJournal(path, operationId, command);
    const lines = bytes.toString("utf8").split("\n").filter(Boolean);
    if (lines.length > 4096) throw new Error("Operation journal is too large");
    lines.forEach((line, index) => {
      const entry = JournalEntrySchema.parse(JSON.parse(line) as unknown);
      if (entry.sequence !== index + 1) {
        throw new Error("Operation journal sequence is invalid");
      }
      journal.entries.push(entry);
    });
    return journal;
  }

  private async append(
    phase: JournalEntry["phase"],
    step: string,
    detail: JournalEntry["detail"],
  ): Promise<void> {
    const last = this.entries.at(-1);
    if (last?.phase === "commit" || last?.phase === "cancel") {
      throw new Error("Operation journal is already terminal");
    }
    if (phase === "effect" && (last?.phase !== "intent" || last.step !== step))
      throw new Error("Effect must follow matching durable intent");
    if (phase === "verify" && (last?.phase !== "effect" || last.step !== step))
      throw new Error("Verification must follow matching effect");
    if (
      phase === "commit" &&
      !this.entries.some(({ phase: entryPhase }) => entryPhase === "verify")
    )
      throw new Error("Cannot report success without verification");
    if (
      phase === "commit" &&
      detail["status"] === "success" &&
      last?.phase !== "verify"
    ) {
      throw new Error("Success requires the final effect verification");
    }
    const entry = JournalEntrySchema.parse({
      sequence: this.entries.length + 1,
      timestamp: new Date().toISOString(),
      phase,
      step,
      detail,
    });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.entries.push(entry);
  }

  intent(step: string, detail: JournalEntry["detail"]): Promise<void> {
    return this.append("intent", step, detail);
  }
  effect(step: string, detail: JournalEntry["detail"]): Promise<void> {
    return this.append("effect", step, detail);
  }
  verify(step: string, detail: JournalEntry["detail"]): Promise<void> {
    return this.append("verify", step, detail);
  }
  compensate(step: string, detail: JournalEntry["detail"]): Promise<void> {
    return this.append("compensate", step, detail);
  }
  commit(detail: JournalEntry["detail"]): Promise<void> {
    return this.append("commit", this.command, detail);
  }
  cancel(detail: JournalEntry["detail"]): Promise<void> {
    return this.append("cancel", this.command, detail);
  }
}

export interface ProcessIdentity {
  readonly pid: number;
  readonly bootId: string;
  readonly processStart: string;
}

const ProcessIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    bootId: z.uuid(),
    processStart: z.string().regex(/^[0-9]+$/),
  })
  .strict();

async function processIdentity(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  try {
    const [bootId, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${String(pid)}/stat`, "utf8"),
    ]);
    const close = stat.lastIndexOf(")");
    if (close < 0) throw new Error("Process stat identity is invalid");
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const processStart = fields[19];
    if (processStart === undefined || !/^[0-9]+$/.test(processStart)) {
      throw new Error("Process start identity is unavailable");
    }
    return ProcessIdentitySchema.parse({
      pid,
      bootId: bootId.trim(),
      processStart,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function currentProcessIdentity(): Promise<ProcessIdentity> {
  const identity = await processIdentity(process.pid);
  if (identity === undefined)
    throw new Error("Current process identity is unavailable");
  return identity;
}

export class InstallationLock {
  private constructor(
    private readonly path: string,
    private readonly device: bigint,
    private readonly inode: bigint,
  ) {}

  static async acquire(
    root: string,
    name: string,
    identity: ProcessIdentity,
  ): Promise<InstallationLock> {
    ProcessIdentitySchema.parse(identity);
    const actualCaller = await currentProcessIdentity();
    if (
      actualCaller.pid !== identity.pid ||
      actualCaller.bootId !== identity.bootId ||
      actualCaller.processStart !== identity.processStart
    ) {
      throw new Error("Installation lock caller identity is stale");
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = resolve(root, `${name}.lock`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(
          path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(`${JSON.stringify(identity)}\n`, "utf8");
        await handle.sync();
        const stats = await handle.stat({ bigint: true });
        await handle.close();
        return new InstallationLock(path, stats.dev, stats.ino);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
        const existing = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let observed: ProcessIdentity;
        try {
          const stats = await existing.stat();
          if (
            !stats.isFile() ||
            stats.nlink !== 1 ||
            stats.uid !== process.getuid?.() ||
            (stats.mode & 0o777) !== 0o600 ||
            stats.size > 4096
          ) {
            throw new Error("Installation lock is unsafe", { cause: error });
          }
          observed = ProcessIdentitySchema.parse(
            JSON.parse((await existing.readFile()).toString("utf8")) as unknown,
          );
        } finally {
          await existing.close();
        }
        const live = await processIdentity(observed.pid);
        if (
          live?.bootId === observed.bootId &&
          live.processStart === observed.processStart
        ) {
          throw new Error("Installation is locked by a live process", {
            cause: error,
          });
        }
        await unlink(path);
      }
    }
    throw new Error("Unable to acquire installation lock");
  }

  async release(): Promise<void> {
    const handle = await open(
      this.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stats = await handle.stat({ bigint: true });
      if (stats.dev !== this.device || stats.ino !== this.inode) {
        throw new Error("Installation lock identity changed before release");
      }
    } finally {
      await handle.close();
    }
    await unlink(this.path);
  }
}
