import { describe, expect, it, vi } from "vitest";

import { runDispatcher } from "../../../src/onboarding/cli/main.js";

describe("bridge-first output isolation", () => {
  it("routes protocol bytes without administrative preview/progress or credentials", async () => {
    let stdout = "";
    let stderr = "";
    const admin = vi.fn();
    const code = await runDispatcher(
      [
        "bridge",
        "--installation",
        "00000000-0000-4000-8000-000000000001",
        "--client",
        "codex",
      ],
      {
        stdout: (value) => (stdout += value),
        stderr: (value) => (stderr += value),
      },
      {
        admin,
        bridge: (_command, io) => {
          io.stdout('{"jsonrpc":"2.0","id":1,"result":{}}\n');
          return Promise.resolve(0);
        },
      },
    );
    expect(code).toBe(0);
    expect(admin).not.toHaveBeenCalled();
    expect(stdout).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(stdout).not.toMatch(/preview|progress|swk\./i);
    expect(stderr).toBe("");
  });
});
