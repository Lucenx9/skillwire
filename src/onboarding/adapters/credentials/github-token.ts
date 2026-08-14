import { randomUUID, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { runCommand } from "../process/command-runner.js";

export const GitHubTokenSchema = z
  .string()
  .min(20)
  .max(512)
  .regex(/^(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})$/);

export async function readBoundedGitHubToken(
  input: AsyncIterable<Uint8Array | string>,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted === true)
    throw new Error("GitHub source credential input cancelled");
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = input[Symbol.asyncIterator]();
  let complete = false;
  let rejectCancellation: ((error: Error) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (): void => {
    rejectCancellation?.(new Error("GitHub source credential input cancelled"));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(() => {
    rejectCancellation?.(
      new Error("GitHub source credential input deadline exceeded"),
    );
  }, 30_000);
  deadline.unref();
  try {
    do {
      const next = await Promise.race([iterator.next(), cancellation]);
      if (next.done) {
        complete = true;
        continue;
      }
      const bytes = Buffer.from(next.value);
      size += bytes.byteLength;
      if (size > 514) throw new Error("GitHub source credential is invalid");
      chunks.push(bytes);
    } while (!complete);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    if (!complete) {
      const returned = iterator.return?.();
      if (returned !== undefined) void returned.catch(() => undefined);
    }
  }
  let token = Buffer.concat(chunks).toString("utf8");
  if (token.endsWith("\r\n")) token = token.slice(0, -2);
  else if (token.endsWith("\n")) token = token.slice(0, -1);
  return GitHubTokenSchema.parse(token);
}

function referenceId(reference: string): string {
  const match = /^secret-service:github:([0-9a-f-]{36})$/.exec(reference);
  if (match?.[1] === undefined || !z.uuid().safeParse(match[1]).success)
    throw new Error("GitHub credential reference is invalid");
  return match[1];
}

function attributes(id: string): readonly string[] {
  z.uuid().parse(id);
  return [
    "application",
    "skillwire",
    "schema",
    "1",
    "purpose",
    "github-source-read-only",
    "credential-ref",
    id,
  ];
}

export class GitHubTokenCredentialStore {
  public constructor(
    private readonly executable = "/usr/bin/secret-tool",
    private readonly environment: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      DBUS_SESSION_BUS_ADDRESS: process.env["DBUS_SESSION_BUS_ADDRESS"],
      XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"],
    },
  ) {
    if (!isAbsolute(executable))
      throw new Error("secret-tool executable must be absolute");
  }

  async store(
    token: string,
    signal?: AbortSignal,
  ): Promise<{ readonly reference: string; readonly referenceId: string }> {
    GitHubTokenSchema.parse(token);
    const id = randomUUID();
    await runCommand({
      executable: resolve(this.executable),
      args: [
        "store",
        "--label",
        "SkillWire read-only GitHub source token",
        ...attributes(id),
      ],
      environment: this.environment,
      stdin: token,
      deadlineMilliseconds: 5_000,
      maximumOutputBytes: 16 * 1024,
      signal,
    });
    const reference = `secret-service:github:${id}`;
    try {
      const persisted = await this.lookup(reference, signal);
      const expectedBytes = Buffer.from(token);
      const persistedBytes = Buffer.from(persisted);
      if (
        expectedBytes.byteLength !== persistedBytes.byteLength ||
        !timingSafeEqual(expectedBytes, persistedBytes)
      ) {
        throw new Error("GitHub credential readback differs");
      }
    } catch (error) {
      await this.clear(reference).catch(() => undefined);
      throw new Error("GitHub credential persistence verification failed", {
        cause: error,
      });
    }
    return { reference, referenceId: id };
  }

  async lookup(reference: string, signal?: AbortSignal): Promise<string> {
    const result = await runCommand({
      executable: resolve(this.executable),
      args: ["lookup", ...attributes(referenceId(reference))],
      environment: this.environment,
      deadlineMilliseconds: 3_000,
      maximumOutputBytes: 1024,
      allowSensitiveStdout: true,
      signal,
    });
    const token = result.stdout.endsWith("\n")
      ? result.stdout.slice(0, -1)
      : result.stdout;
    return GitHubTokenSchema.parse(token);
  }

  async clear(reference: string, signal?: AbortSignal): Promise<void> {
    await runCommand({
      executable: resolve(this.executable),
      args: ["clear", ...attributes(referenceId(reference))],
      environment: this.environment,
      acceptExitCodes: [0, 1],
      deadlineMilliseconds: 3_000,
      maximumOutputBytes: 16 * 1024,
      signal,
    });
  }
}
