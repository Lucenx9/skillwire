import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import {
  InstallationSchema,
  type Installation,
} from "../domain/installation.js";

export interface StatusProbeResult {
  readonly component: string;
  readonly state: string;
  readonly identity?: Readonly<
    Record<string, string | number | boolean | null>
  >;
}

export interface StatusProbe {
  readonly component: string;
  inspect(signal: AbortSignal): Promise<StatusProbeResult>;
}

export interface InstalledStatus {
  readonly installation: Installation;
  readonly live: readonly StatusProbeResult[];
}

async function readProtectedJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > 256 * 1024
    ) {
      throw new Error("Installed state file is unsafe");
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

export async function inspectInstalledStatus(options: {
  readonly stateRoot: string;
  readonly probes?: readonly StatusProbe[];
  readonly signal: AbortSignal;
}): Promise<InstalledStatus> {
  if (options.signal.aborted) throw new Error("Status inspection cancelled");
  const installation = InstallationSchema.parse(
    await readProtectedJson(resolve(options.stateRoot, "installation.json")),
  );
  const live: StatusProbeResult[] = [];
  for (const probe of options.probes ?? []) {
    const result = await probe.inspect(options.signal);
    if (result.component !== probe.component)
      throw new Error("Status probe component identity changed");
    live.push(result);
  }
  return { installation, live };
}
