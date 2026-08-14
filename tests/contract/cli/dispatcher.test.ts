import { describe, expect, it, vi } from "vitest";

import {
  parseCommandLine,
  runDispatcher,
} from "../../../src/onboarding/cli/main.js";
import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";

describe("one-pass skillwire dispatcher grammar", () => {
  it.each([
    [["setup", "--clients", "none"], "setup"],
    [["status"], "status"],
    [["doctor"], "doctor"],
    [["clients", "list"], "clients:list"],
    [["clients", "install", "codex"], "clients:install"],
    [["clients", "verify", "claude"], "clients:verify"],
    [["clients", "uninstall", "codex"], "clients:uninstall"],
    [["clients", "rotate-key", "claude"], "clients:rotate-key"],
    [["repair"], "repair"],
    [["backup"], "backup"],
    [["upgrade", "--release", "/tmp/release.tar.zst"], "upgrade"],
    [
      ["maintenance", "rotate-service-secret", "database-password"],
      "maintenance:rotate-service-secret",
    ],
    [["uninstall"], "uninstall"],
    [["purge"], "purge"],
    [
      [
        "bridge",
        "--installation",
        "00000000-0000-4000-8000-000000000001",
        "--client",
        "codex",
      ],
      "bridge",
    ],
  ])("parses %j to %s", (argv, route) => {
    expect(parseCommandLine(argv).route).toBe(route);
  });

  it("rejects unknown/repeated/relative/contradictory arguments before effects", () => {
    expect(() =>
      parseCommandLine(["setup", "--clients", "codex", "--clients", "claude"]),
    ).toThrow();
    expect(() =>
      parseCommandLine(["upgrade", "--release", "relative.tar.zst"]),
    ).toThrow();
    expect(() => parseCommandLine(["status", "--unexpected"])).toThrow();
    expect(() =>
      parseCommandLine([
        "setup",
        "--clients",
        "none",
        "--source",
        "unknown/source",
      ]),
    ).toThrow();
  });

  it("redacts invalid invocation text before writing diagnostics", async () => {
    const token = createApiKeyToken().token;
    let stderr = "";
    const code = await runDispatcher(
      [token],
      {
        stdout: vi.fn(),
        stderr: (value) => {
          stderr += value;
        },
      },
      { admin: vi.fn(), bridge: vi.fn() },
    );
    expect(code).toBe(2);
    expect(stderr).not.toContain(token);
    expect(stderr).toContain("[REDACTED]");
  });
});
