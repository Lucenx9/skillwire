import { constants } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { open, mkdir, readFile } from "node:fs/promises";
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

export class JournaledEffectError extends Error {
  public constructor(
    message: string,
    readonly effectMayHaveBegun: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JournaledEffectError";
  }
}

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
    const resumingCancelledOperation =
      last?.phase === "cancel" &&
      (last.detail["status"] === "failed" ||
        last.detail["status"] === "recovery-required") &&
      phase === "compensate";
    if (
      last?.phase === "commit" ||
      (last?.phase === "cancel" && !resumingCancelledOperation)
    ) {
      throw new Error("Operation journal is already terminal");
    }
    if (phase === "effect" && (last?.phase !== "intent" || last.step !== step))
      throw new Error("Effect must follow matching durable intent");
    if (phase === "verify" && (last?.phase !== "effect" || last.step !== step))
      throw new Error("Verification must follow matching effect");
    const recoveredCommit =
      phase === "commit" &&
      detail["status"] === "recovered" &&
      last?.phase === "compensate" &&
      last.detail["completion"] !== "unproven";
    if (
      phase === "commit" &&
      !recoveredCommit &&
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

  async runEffect<T>(options: {
    readonly step: string;
    readonly intent: JournalEntry["detail"];
    readonly signal: AbortSignal;
    readonly action: () => Promise<T>;
    readonly effectNotStarted?: (error: unknown) => boolean;
    readonly verification: (value: T) => JournalEntry["detail"];
  }): Promise<T> {
    await this.intent(options.step, options.intent);
    if (options.signal.aborted) {
      throw new JournaledEffectError(
        `Operation cancelled before ${options.step} began`,
        false,
      );
    }
    let value: T;
    try {
      value = await options.action();
      await this.effect(options.step, { completion: "recorded" });
      await this.verify(options.step, options.verification(value));
    } catch (error) {
      if (options.effectNotStarted?.(error) === true) {
        await this.compensate(options.step, {
          completion: "not-started",
          recoveryRequired: false,
        });
        throw error;
      }
      await this.compensate(options.step, {
        completion: "unproven",
        recoveryRequired: true,
      });
      throw new JournaledEffectError(
        `${options.step} may have begun without proven completion`,
        true,
        { cause: error },
      );
    }
    return value;
  }

  hasUnprovenEffect(): boolean {
    const unproven = new Set<string>();
    for (const entry of this.entries) {
      if (entry.phase !== "compensate") continue;
      if (entry.detail["completion"] === "unproven") unproven.add(entry.step);
      else unproven.delete(entry.step);
    }
    return unproven.size > 0;
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
    private readonly holder: ChildProcessWithoutNullStreams,
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
    const rootHandle = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stats = await rootHandle.stat();
      if (
        !stats.isDirectory() ||
        stats.uid !== (process.getuid?.() ?? -1) ||
        (stats.mode & 0o077) !== 0
      ) {
        throw new Error("Installation lock directory is unsafe");
      }
    } finally {
      await rootHandle.close();
    }
    const path = resolve(root, `${name}.lock`);
    let lockFile;
    try {
      lockFile = await open(
        path,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
      lockFile = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    try {
      const stats = await lockFile.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size > 4096
      ) {
        throw new Error("Installation lock is unsafe");
      }
    } finally {
      await lockFile.close();
    }

    const holder = spawn(
      "/usr/bin/flock",
      [
        "--exclusive",
        "--nonblock",
        "--no-fork",
        path,
        process.execPath,
        "-e",
        'process.stdout.write("locked\\n");process.stdin.resume();process.stdin.once("data",()=>process.exit(0))',
      ],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const outcome = await Promise.race([
      new Promise<"ready">((done) => {
        holder.stdout.once("data", (chunk: Buffer) => {
          if (chunk.toString("utf8") === "locked\n") done("ready");
        });
      }),
      once(holder, "exit").then(() => "exit" as const),
      once(holder, "error").then(() => "error" as const),
      new Promise<"timeout">((done) => {
        const timer = setTimeout(() => {
          done("timeout");
        }, 2_000);
        timer.unref();
      }),
    ]);
    if (outcome !== "ready") {
      holder.kill("SIGKILL");
      throw new Error("Installation is locked by a live process");
    }
    try {
      const metadata = await open(
        path,
        constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      );
      try {
        await metadata.writeFile(`${JSON.stringify(identity)}\n`, "utf8");
        await metadata.sync();
      } finally {
        await metadata.close();
      }
    } catch (error) {
      holder.stdin.end("release\n");
      await once(holder, "exit").catch(() => undefined);
      throw error;
    }
    return new InstallationLock(path, holder);
  }

  async release(): Promise<void> {
    if (this.holder.exitCode !== null || this.holder.signalCode !== null)
      throw new Error("Installation lock holder exited before release");
    this.holder.stdin.end("release\n");
    const outcome = await Promise.race([
      once(this.holder, "exit").then(() => "exit" as const),
      new Promise<"timeout">((done) => {
        const timer = setTimeout(() => {
          done("timeout");
        }, 2_000);
        timer.unref();
      }),
    ]);
    if (outcome !== "exit") {
      this.holder.kill("SIGKILL");
      await once(this.holder, "exit").catch(() => undefined);
      throw new Error(`Installation lock ${this.path} did not release safely`);
    }
  }
}
