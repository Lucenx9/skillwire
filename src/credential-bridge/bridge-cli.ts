import { isAbsolute, resolve } from "node:path";

import type { DispatcherIo, ParsedCommand } from "../onboarding/cli/main.js";
import { redactText } from "../onboarding/cli/output.js";
import {
  CredentialResolver,
  type ResolvedBridgeCredential,
} from "./credential-resolver.js";
import { serveStdioProxy } from "./stdio-server.js";
import { connectUpstream, type UpstreamConnection } from "./upstream-client.js";

export interface BridgeLifecycleOptions {
  readonly installationId: string;
  readonly client: "codex" | "claude";
  readonly startedAt: number;
  readonly deadlineMilliseconds?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface BridgeLifecycleDependencies {
  resolve(
    installationId: string,
    client: "codex" | "claude",
  ): Promise<ResolvedBridgeCredential>;
  connect(options: {
    endpoint: URL;
    token: string;
    deadlineMilliseconds: number;
    signal: AbortSignal;
  }): Promise<UpstreamConnection>;
  serve(
    connection: UpstreamConnection,
    signal: AbortSignal,
    ready: () => void,
  ): Promise<void>;
}

export function resolveBridgeRoots(
  environment: NodeJS.ProcessEnv,
): { readonly dataRoot: string; readonly stateRoot: string } | undefined {
  const home = environment["HOME"];
  const dataHome = environment["XDG_DATA_HOME"];
  const stateHome = environment["XDG_STATE_HOME"];
  if (
    (dataHome !== undefined && !isAbsolute(dataHome)) ||
    (stateHome !== undefined && !isAbsolute(stateHome)) ||
    ((dataHome === undefined || stateHome === undefined) &&
      (home === undefined || !isAbsolute(home)))
  ) {
    return undefined;
  }
  return {
    dataRoot: resolve(
      dataHome ?? resolve(home ?? "", ".local/share"),
      "skillwire",
    ),
    stateRoot: resolve(
      stateHome ?? resolve(home ?? "", ".local/state"),
      "skillwire",
    ),
  };
}

export async function runBridgeLifecycle(
  options: BridgeLifecycleOptions,
  dependencies: BridgeLifecycleDependencies,
): Promise<void> {
  const total = options.deadlineMilliseconds ?? 10_000;
  if (total < 1 || total > 10_000)
    throw new Error("Credential bridge deadline is invalid");
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted === true) controller.abort();
  const remaining = Math.max(
    0,
    total - (performance.now() - options.startedAt),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Credential bridge end-to-end deadline exceeded"));
    }, remaining);
  });
  let connection: UpstreamConnection | undefined;
  let serving: Promise<void> | undefined;
  try {
    await Promise.race([
      (async () => {
        const credential = await dependencies.resolve(
          options.installationId,
          options.client,
        );
        const budget = Math.max(
          1,
          Math.floor(total - (performance.now() - options.startedAt)),
        );
        const activeConnection = await dependencies.connect({
          endpoint: credential.endpoint,
          token: credential.token,
          deadlineMilliseconds: budget,
          signal: controller.signal,
        });
        connection = activeConnection;
        await new Promise<void>((ready, reject) => {
          serving = dependencies.serve(
            activeConnection,
            controller.signal,
            ready,
          );
          void serving.catch(reject);
        });
      })(),
      deadline,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    await serving;
  } finally {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    await connection?.close().catch(() => undefined);
  }
}

export async function runBridgeCommand(
  command: ParsedCommand,
  io: DispatcherIo,
  signal: AbortSignal,
): Promise<number> {
  if (
    command.route !== "bridge" ||
    command.installationId === undefined ||
    command.client === undefined
  )
    return 2;
  const bridgeRoots = resolveBridgeRoots(process.env);
  if (bridgeRoots === undefined) return 4;
  const resolver = new CredentialResolver(
    bridgeRoots.stateRoot,
    bridgeRoots.dataRoot,
  );
  try {
    await runBridgeLifecycle(
      {
        installationId: command.installationId,
        client: command.client,
        startedAt: performance.now(),
        signal,
      },
      {
        resolve: (installationId, client) =>
          resolver.resolve(installationId, client),
        connect: (options) => connectUpstream(options),
        serve: serveStdioProxy,
      },
    );
    return 0;
  } catch (error) {
    io.stderr(
      `${redactText(error instanceof Error ? error.message : "Credential bridge failed")}\n`,
    );
    return 7;
  }
}
