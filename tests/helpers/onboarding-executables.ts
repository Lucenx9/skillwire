import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type FakeExecutable =
  "codex" | "claude" | "secret-tool" | "cosign" | "docker" | "signal";

const FAKE_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const statePath = process.env.SKILLWIRE_FAKE_STATE;
const state = statePath && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
if (process.env.SKILLWIRE_FAKE_SIGNAL === "wait") {
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGINT", () => process.exit(130));
  setInterval(() => {}, 1000);
} else if (process.env.SKILLWIRE_FAKE_EXIT) {
  process.stderr.write("bounded fake failure\\n");
  process.exit(Number(process.env.SKILLWIRE_FAKE_EXIT));
} else {
  const stdin = fs.readFileSync(0, "utf8");
  const result = { name, args, stdinBytes: Buffer.byteLength(stdin), state };
  process.stdout.write(JSON.stringify(result) + "\\n");
}
`;

export async function createFakeExecutables(
  root: string,
): Promise<Record<FakeExecutable, string>> {
  const directory = resolve(root, "fake-bin");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const names: readonly FakeExecutable[] = [
    "codex",
    "claude",
    "secret-tool",
    "cosign",
    "docker",
    "signal",
  ];
  const entries = await Promise.all(
    names.map(async (name) => {
      const path = resolve(directory, name);
      await writeFile(path, FAKE_SOURCE, { mode: 0o700, flag: "wx" });
      await chmod(path, 0o700);
      return [name, path] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<FakeExecutable, string>;
}
