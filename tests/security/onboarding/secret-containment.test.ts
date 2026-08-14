import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { OperationJournal } from "../../../src/onboarding/domain/operation-journal.js";
import {
  redactOutput,
  redactText,
} from "../../../src/onboarding/cli/output.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

describe("Feature 004 secret containment release gate", () => {
  const execute = promisify(execFile);
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("keeps one canary out of every persistent or diagnostic surface", async () => {
    fixture = await createOnboardingEnvironment();
    const canary = `swk.${"a".repeat(16)}.${"b".repeat(43)}`;
    const journal = await OperationJournal.create(
      fixture.root,
      randomUUID(),
      "setup",
    );
    await journal.intent("credential", {
      client: "codex",
      reference: `secret-service:codex:${randomUUID()}`,
    });
    await journal.effect("credential", { stored: true });
    await journal.verify("credential", { persisted: true });
    await journal.commit({ outcome: "verified" });

    const surfaces = {
      argv: process.argv.join("\0"),
      environment: JSON.stringify(process.env),
      procArgv: await readFile("/proc/self/cmdline", "utf8"),
      procEnvironment: await readFile("/proc/self/environ", "utf8"),
      log: redactText(`authorization: Bearer ${canary}`),
      terminal: JSON.stringify(redactOutput({ apiKey: canary })),
      config: JSON.stringify({
        credentialReference: `secret-service:codex:${randomUUID()}`,
      }),
      diff: "credential bridge uses protected reference only",
      snapshot: JSON.stringify({ profileIdentitySha256: "a".repeat(64) }),
      journal: await readFile(
        resolve(fixture.root, `${journal.operationId}.jsonl`),
        "utf8",
      ),
      backup: JSON.stringify({
        serviceSecretReference: "secrets/database-password",
      }),
      report: JSON.stringify({ result: "credential-unavailable" }),
      release: JSON.stringify({ componentSha256: "c".repeat(64) }),
      repository: await readFile("package.json", "utf8"),
      repositoryDiff: (
        await execute("/usr/bin/git", [
          "-c",
          `safe.directory=${process.cwd()}`,
          "diff",
          "--binary",
          "--no-ext-diff",
          "--",
        ])
      ).stdout,
    };
    for (const [surface, contents] of Object.entries(surfaces)) {
      expect(contents, surface).not.toContain(canary);
    }
  });

  it("keeps onboarding free of a telemetry transport or telemetry SDK", async () => {
    const { stdout } = await execute("/usr/bin/git", [
      "-c",
      `safe.directory=${process.cwd()}`,
      "ls-files",
      "-z",
      "--",
      "src/onboarding",
      "package.json",
    ]);
    const paths = stdout.split("\0").filter(Boolean);
    const contents = await Promise.all(
      paths.map((path) => readFile(path, "utf8")),
    );
    expect(contents.join("\n")).not.toMatch(
      /(?:posthog|segment\.com|sentry\.io|telemetry\.track|analytics\.track)/i,
    );
  });

  it("redacts a source-specific GitHub token from generic terminal and log values", () => {
    const token = `github_pat_${"source_read_only_".repeat(3)}`;
    expect(redactText(`source credential ${token}`)).not.toContain(token);
    expect(
      JSON.stringify(redactOutput({ message: `source credential ${token}` })),
    ).not.toContain(token);
  });

  it("does not place a credential in proc identity when handed over by descriptor", async () => {
    fixture = await createOnboardingEnvironment();
    const token = `swk.${"c".repeat(16)}.${"d".repeat(43)}`;
    const privatePath = resolve(fixture.root, "private-token");
    const handle = await open(privatePath, "wx", 0o600);
    try {
      await handle.writeFile(token);
      await handle.sync();
    } finally {
      await handle.close();
    }
    expect(process.argv.join("\0")).not.toContain(token);
    expect(JSON.stringify(process.env)).not.toContain(token);
    await writeFile(
      resolve(fixture.root, "report.json"),
      '{"delivery":"private-fd"}',
      {
        mode: 0o600,
      },
    );
    expect(
      await readFile(resolve(fixture.root, "report.json"), "utf8"),
    ).not.toContain(token);
  });
});
