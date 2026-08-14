import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  installCancellationSignals,
  runDispatcher,
} from "../../../src/onboarding/cli/main.js";
import { runProductionSetup } from "../../../src/onboarding/application/production-setup.js";
import { createOnboardingEnvironment } from "../../helpers/onboarding-environment.js";

describe("dispatcher cancellation and output separation", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "propagates %s to one shared AbortSignal and removes handlers",
    (name) => {
      const controller = new AbortController();
      const dispose = installCancellationSignals(controller);
      process.emit(name, name);
      expect(controller.signal.aborted).toBe(true);
      dispose();
    },
  );

  it("passes cancellation to the active administrative route and returns its safe exit", async () => {
    let observedAbort = false;
    const code = await runDispatcher(
      ["status"],
      { stdout: vi.fn(), stderr: vi.fn() },
      {
        bridge: vi.fn(),
        admin: (_command, _io, signal) => {
          process.emit("SIGTERM", "SIGTERM");
          observedAbort = signal.aborted;
          return Promise.resolve(11);
        },
      },
    );
    expect(observedAbort).toBe(true);
    expect(code).toBe(11);
  });

  it("maps stable admin exit codes with pure JSON stdout and human diagnostics on stderr", async () => {
    let stdout = "";
    let stderr = "";
    const bridge = vi.fn();
    const code = await runDispatcher(
      ["status", "--output", "json"],
      {
        stdout: (value) => (stdout += value),
        stderr: (value) => (stderr += value),
      },
      {
        bridge,
        admin: (_command, io) => {
          io.stdout(
            '{"schemaVersion":"skillwire.admin-result/v1","exitClass":"success"}\n',
          );
          return Promise.resolve(0);
        },
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ exitClass: "success" });
    expect(stderr).toBe("");
    expect(bridge).not.toHaveBeenCalled();
  });

  it("durably cancels before effects when setup receives an aborted signal", async () => {
    const fixture = await createOnboardingEnvironment();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        runProductionSetup(
          { clients: "none", credentialBackend: "not-selected" },
          controller.signal,
          fixture.environment,
        ),
      ).rejects.toThrow(/cancelled/i);
      const operations = resolve(fixture.xdgStateHome, "skillwire/operations");
      const files = await readdir(operations);
      expect(files).toHaveLength(1);
      const file = files[0];
      if (file === undefined)
        throw new Error("Cancellation journal is missing");
      const journal = await readFile(resolve(operations, file), "utf8");
      expect(
        journal
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { phase: string }).phase),
      ).toEqual(["intent", "cancel"]);
    } finally {
      await fixture.close();
    }
  });
});
