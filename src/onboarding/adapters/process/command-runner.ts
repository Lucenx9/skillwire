import { spawn } from "node:child_process";
import { once } from "node:events";
import { isAbsolute } from "node:path";

export type CommandFailureKind =
  "invalid" | "spawn" | "deadline" | "cancelled" | "output-limit" | "exit";

export class CommandFailure extends Error {
  public constructor(
    readonly kind: CommandFailureKind,
    message: string,
    readonly code?: number | undefined,
  ) {
    super(message);
    this.name = "CommandFailure";
  }
}

export interface CommandOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly stdin?: string | Uint8Array | undefined;
  readonly deadlineMilliseconds?: number | undefined;
  readonly maximumOutputBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly acceptExitCodes?: readonly number[] | undefined;
  readonly allowSensitiveStdout?: boolean | undefined;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMilliseconds: number;
}

const SECRET_PATTERN =
  /(?:swk\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}|bearer\s+\S+|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/gi;
const PROCESS_INJECTION_ENVIRONMENT =
  /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|CDPATH$|PYTHON(?:HOME|PATH)$|RUBYOPT$|PERL5OPT$|GIT_CONFIG|SSH_ASKPASS$)/i;

function redact(value: string): string {
  return value.replace(SECRET_PATTERN, "[REDACTED]");
}

function sanitizedEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const source = environment ?? {};
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const safeFileReference =
      key.endsWith("_FILE") && value !== undefined && isAbsolute(value);
    if (
      value !== undefined &&
      /^[A-Z_][A-Z0-9_]*$/.test(key) &&
      !PROCESS_INJECTION_ENVIRONMENT.test(key) &&
      (safeFileReference ||
        !/TOKEN|SECRET|PASSWORD|PEPPER|CREDENTIAL|DATABASE_URL/i.test(key))
    ) {
      result[key] = value;
    }
  }
  return result;
}

export async function runCommand(
  options: CommandOptions,
): Promise<CommandResult> {
  if (!isAbsolute(options.executable))
    throw new CommandFailure("invalid", "Executable must be absolute");
  if (options.args.some((argument) => argument.includes("\0")))
    throw new CommandFailure("invalid", "Argument contains NUL");
  const deadlineMilliseconds = options.deadlineMilliseconds ?? 10_000;
  const maximumOutputBytes = options.maximumOutputBytes ?? 256 * 1024;
  if (deadlineMilliseconds < 1 || deadlineMilliseconds > 10 * 60_000)
    throw new CommandFailure("invalid", "Deadline is invalid");
  const startedAt = performance.now();
  if (options.signal?.aborted === true)
    throw new CommandFailure("cancelled", "Command cancelled");

  const child = spawn(options.executable, [...options.args], {
    cwd: options.cwd,
    env: sanitizedEnvironment(options.environment),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  let failureKind: CommandFailureKind | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const terminate = (kind: CommandFailureKind): void => {
    failureKind ??= kind;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    forceKillTimer ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 250);
    forceKillTimer.unref();
  };

  const append = (current: Buffer, chunk: Buffer): Buffer => {
    const combined = Buffer.concat([current, chunk]);
    if (combined.byteLength > maximumOutputBytes) {
      terminate("output-limit");
      return combined.subarray(0, maximumOutputBytes);
    }
    return combined;
  };
  child.stdout.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
  child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
  child.stdin.end(options.stdin);
  const onAbort = (): void => {
    terminate("cancelled");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    terminate("deadline");
  }, deadlineMilliseconds);
  timer.unref();

  let code: number | null;
  try {
    const outcome = await Promise.race([
      once(child, "exit").then(([exitCode]) => ({
        type: "exit" as const,
        exitCode: exitCode as number | null,
      })),
      once(child, "error").then(([error]) => ({
        type: "error" as const,
        error: error as Error,
      })),
    ]);
    if (outcome.type === "error")
      throw new CommandFailure("spawn", "Unable to start command");
    code = outcome.exitCode;
  } finally {
    clearTimeout(timer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  const redactedStdout =
    options.allowSensitiveStdout === true
      ? stdout.toString("utf8")
      : redact(stdout.toString("utf8"));
  const redactedStderr = redact(stderr.toString("utf8"));
  if (failureKind !== undefined)
    throw new CommandFailure(failureKind, `Command ${failureKind}`);
  const effectiveCode = code ?? 1;
  if (!(options.acceptExitCodes ?? [0]).includes(effectiveCode)) {
    throw new CommandFailure(
      "exit",
      `Command failed (${String(effectiveCode)}): ${redactedStderr.slice(0, 512)}`,
      effectiveCode,
    );
  }
  return {
    code: effectiveCode,
    stdout: redactedStdout,
    stderr: redactedStderr,
    durationMilliseconds: performance.now() - startedAt,
  };
}
