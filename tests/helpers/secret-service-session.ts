import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export interface SecretServiceSession {
  readonly root: string;
  readonly password: string;
  readonly environment: NodeJS.ProcessEnv;
  run(
    command: string,
    args?: readonly string[],
    stdin?: string,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  stopProvider(): Promise<void>;
  close(options?: { retainXdg?: boolean }): Promise<void>;
}

export interface CreateSecretServiceSessionOptions {
  readonly root?: string | undefined;
  readonly password?: string | undefined;
  readonly providerExecutable?: string | undefined;
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    exited.then(() => "exited" as const),
    new Promise<"timeout">((done) => {
      timeout = setTimeout(() => {
        done("timeout");
      }, 2_000);
      timeout.unref();
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (outcome === "timeout") {
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
}

export async function createSecretServiceSession(
  options: CreateSecretServiceSessionOptions = {},
): Promise<SecretServiceSession> {
  const root =
    options.root ??
    (await mkdtemp(resolve(tmpdir(), "skillwire-secret-service-")));
  const password = options.password ?? randomBytes(32).toString("base64url");
  const providerExecutable =
    options.providerExecutable ?? "/usr/bin/gnome-keyring-daemon";
  const data = resolve(root, "data");
  const config = resolve(root, "config");
  const runtime = resolve(root, "runtime");
  const home = resolve(root, "home");
  await Promise.all(
    [data, config, runtime, home].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  try {
    await access(providerExecutable);
  } catch (error) {
    if (options.root === undefined)
      await rm(root, { recursive: true, force: true });
    throw new Error("Secret Service provider executable is unavailable", {
      cause: error,
    });
  }
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    XDG_RUNTIME_DIR: runtime,
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
  const bus = spawn(
    "/usr/bin/dbus-daemon",
    ["--session", "--nofork", "--print-address=1", "--print-pid=1"],
    {
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const lines: string[] = [];
  const reader = createInterface({ input: bus.stdout });
  try {
    for await (const line of reader) {
      lines.push(line);
      if (lines.length === 2) break;
    }
  } finally {
    reader.close();
  }
  const address = lines[0];
  const pid = lines[1];
  if (address === undefined || pid === undefined || !/^\d+$/.test(pid)) {
    bus.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
    throw new Error("Unable to create an isolated D-Bus session");
  }
  environment["DBUS_SESSION_BUS_ADDRESS"] = address;
  environment["DBUS_SESSION_BUS_PID"] = pid;
  const provider = spawn(
    providerExecutable,
    ["--foreground", "--components=secrets", "--unlock"],
    {
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  provider.stdin.end(password);
  let providerStdout = "";
  let providerStderr = "";
  provider.stdout
    .setEncoding("utf8")
    .on("data", (chunk: string) => (providerStdout += chunk.slice(0, 4096)));
  provider.stderr
    .setEncoding("utf8")
    .on("data", (chunk: string) => (providerStderr += chunk.slice(0, 4096)));
  const providerDeadline = Date.now() + 5_000;
  for (;;) {
    if (provider.exitCode !== null) {
      await waitForExit(bus);
      if (options.root === undefined)
        await rm(root, { recursive: true, force: true });
      throw new Error(
        `Unable to start isolated Secret Service provider: ${providerStderr.slice(0, 256)}`,
      );
    }
    const probe = await new Promise<{ code: number; stdout: string }>(
      (done) => {
        const child = spawn(
          "/usr/bin/dbus-send",
          [
            "--session",
            "--print-reply",
            "--dest=org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus.NameHasOwner",
            "string:org.freedesktop.secrets",
          ],
          {
            env: environment,
            shell: false,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.once("exit", (code) => {
          done({ code: code ?? 1, stdout });
        });
        child.once("error", () => {
          done({ code: 1, stdout: "" });
        });
      },
    );
    if (probe.code === 0 && probe.stdout.includes("boolean true")) break;
    if (Date.now() >= providerDeadline) {
      await Promise.all([waitForExit(provider), waitForExit(bus)]);
      if (options.root === undefined)
        await rm(root, { recursive: true, force: true });
      throw new Error(
        `Isolated Secret Service provider did not own its D-Bus name: ${providerStdout.slice(0, 128)} ${providerStderr.slice(0, 128)}`,
      );
    }
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  let closed = false;
  let providerStopped = false;

  return {
    root,
    password,
    environment,
    run: async (command, args = [], stdin) => {
      if (closed) throw new Error("Secret Service session is closed");
      const child = spawn(command, [...args], {
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout
        .setEncoding("utf8")
        .on("data", (chunk: string) => (stdout += chunk));
      child.stderr
        .setEncoding("utf8")
        .on("data", (chunk: string) => (stderr += chunk));
      child.stdin.end(stdin);
      const [code] = (await once(child, "exit")) as [number | null];
      return { code: code ?? 1, stdout, stderr };
    },
    stopProvider: async () => {
      if (providerStopped) return;
      providerStopped = true;
      await waitForExit(provider);
    },
    close: async ({ retainXdg = false } = {}) => {
      if (closed) return;
      closed = true;
      await waitForExit(provider);
      await waitForExit(bus);
      await rm(runtime, { recursive: true, force: true });
      if (!retainXdg) await rm(root, { recursive: true, force: true });
    },
  };
}
