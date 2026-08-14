import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createFakeExecutables } from "../../helpers/onboarding-executables.js";
import { createOnboardingEnvironment } from "../../helpers/onboarding-environment.js";
import { createSecretServiceSession } from "../../helpers/secret-service-session.js";
import { runCommand } from "../../../src/onboarding/adapters/process/command-runner.js";

describe("disposable onboarding infrastructure", () => {
  it("isolates all normal profiles and rejects real profile/workspace targets", async () => {
    const fixture = await createOnboardingEnvironment();
    try {
      expect(fixture.home).toContain(fixture.root);
      expect(fixture.environment["HOME"]).toBe(fixture.home);
      expect(fixture.environment["DOCKER_HOST"]).toBe(
        process.env["DOCKER_HOST"],
      );
      expect(fixture.composeProject).toMatch(/^skillwire-test-[0-9a-f]{16}$/);
      expect(() => {
        fixture.assertMutablePath(process.cwd());
      }).toThrow(/escapes|real profile/);
      const realHome = process.env["HOME"];
      if (realHome !== undefined) {
        expect(() => {
          fixture.assertMutablePath(realHome);
        }).toThrow();
      }
      expect(() => {
        fixture.assertMutablePath(resolve(fixture.root, "owned"));
      }).not.toThrow();
    } finally {
      await fixture.close();
    }
  });

  it("creates absolute deterministic fake executable boundaries", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "skillwire-fake-test-"));
    await writeFile(resolve(root, "state.json"), "{}\n");
    const executables = await createFakeExecutables(root);
    expect(Object.keys(executables).sort()).toEqual([
      "claude",
      "codex",
      "cosign",
      "docker",
      "secret-tool",
      "signal",
    ]);
    expect(
      Object.values(executables).every((path) => path.startsWith(root)),
    ).toBe(true);
    await expect(
      runCommand({
        executable: executables.cosign,
        args: ["verify-blob"],
        environment: { PATH: "/nonexistent", LANG: "C" },
      }),
    ).resolves.toMatchObject({ code: 0 });
  });

  it("checks out immutable package-source history before mounting Git into the test container", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    const containerStart = workflow.indexOf("\n  container:\n");
    expect(containerStart).toBeGreaterThanOrEqual(0);
    const containerJob = workflow.slice(containerStart);
    const checkoutStart = containerJob.indexOf("actions/checkout@");
    const setupNodeStart = containerJob.indexOf("actions/setup-node@");
    expect(checkoutStart).toBeGreaterThanOrEqual(0);
    expect(setupNodeStart).toBeGreaterThan(checkoutStart);
    expect(containerJob.slice(checkoutStart, setupNodeStart)).toContain(
      "fetch-depth: 0",
    );
  });

  it.skipIf(!existsSync("/usr/bin/gnome-keyring-daemon"))(
    "shares one isolated D-Bus session across fresh processes and tears runtime down",
    async () => {
      const session = await createSecretServiceSession();
      const root = session.root;
      const args = [
        "--session",
        "--dest=org.freedesktop.DBus",
        "--type=method_call",
        "--print-reply",
        "/",
        "org.freedesktop.DBus.ListNames",
      ];
      expect((await session.run("/usr/bin/dbus-send", args)).code).toBe(0);
      expect((await session.run("/usr/bin/dbus-send", args)).code).toBe(0);
      await session.close({ retainXdg: true });
      await expect(access(resolve(root, "data"))).resolves.toBeUndefined();
      await expect(access(resolve(root, "runtime"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
