import { spawn } from "node:child_process";
import { once } from "node:events";
import { open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { writePrivateToken } from "../../../src/authentication/admin-cli.js";
import {
  bootstrapAccountArguments,
  bootstrapAdminArguments,
} from "../../../src/onboarding/adapters/postgres/bootstrap-admin.js";

describe("one-shot private API key channel", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("writes only to a validated inherited descriptor, never argv/env/stdout/stderr", async () => {
    fixture = await createOnboardingEnvironment();
    const path = resolve(fixture.root, "private-token");
    const handle = await open(path, "wx", 0o600);
    const token = createApiKeyToken().token;
    try {
      writePrivateToken({ token, fileDescriptor: handle.fd });
    } finally {
      await handle.close();
    }
    expect(await readFile(path, "utf8")).toBe(token);
    expect(process.argv.join(" ")).not.toContain(token);
    expect(JSON.stringify(process.env)).not.toContain(token);
    await rm(path);
  });

  it("uses a no-log one-shot administration container and names only a private FIFO path", () => {
    const args = bootstrapAdminArguments({
      composePath: "/owned/compose.yaml",
      projectName: "skillwire-test-fixture",
      privateDirectory: "/owned/runtime/admin-key-fixture",
      accountId: "00000000-0000-4000-8000-000000000001",
      keyId: "00000000-0000-4000-8000-000000000002",
      containerUser: "1234:5678",
      databasePasswordFile: "/owned/secrets/database-password",
      applicationPepperFile: "/owned/secrets/application-pepper",
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "--no-TTY",
        "--no-deps",
        "--token-output",
        "/run/skillwire-private/token",
        "--key-id",
        "00000000-0000-4000-8000-000000000002",
      ]),
    );
    expect(args).toEqual(expect.arrayContaining(["--user", "1234:5678"]));
    expect(args).toEqual(expect.arrayContaining(["--entrypoint", "node"]));
    expect(args).toEqual(
      expect.arrayContaining([
        "SKILLWIRE_DATABASE_PASSWORD_FILE=/run/skillwire-admin/database-password",
        "SKILLWIRE_API_KEY_PEPPER_FILE=/run/skillwire-admin/application-pepper",
        "/owned/secrets/database-password:/run/skillwire-admin/database-password:ro",
        "/owned/secrets/application-pepper:/run/skillwire-admin/application-pepper:ro",
      ]),
    );
    expect(args).toContain("admin");
    expect(args.join(" ")).not.toMatch(/swk\.|--token-fd\s+[0-9]/i);
  });

  it("creates the account through the same no-log administration service without a private channel", () => {
    const args = bootstrapAccountArguments({
      composePath: "/owned/compose.yaml",
      projectName: "skillwire-test-fixture",
      containerUser: "1234:5678",
      databasePasswordFile: "/owned/secrets/database-password",
      applicationPepperFile: "/owned/secrets/application-pepper",
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "--no-TTY",
        "--no-deps",
        "--user",
        "1234:5678",
        "admin",
        "account:create",
      ]),
    );
  });

  it("keeps a live one-shot token out of process identity and terminal channels", async () => {
    fixture = await createOnboardingEnvironment();
    const path = resolve(fixture.root, "live-private-token");
    const handle = await open(path, "wx", 0o600);
    const source = [
      "const {randomBytes}=require('node:crypto')",
      "const fs=require('node:fs')",
      "const token=`swk.${randomBytes(12).toString('base64url')}.${randomBytes(32).toString('base64url')}`",
      "fs.writeSync(3,token)",
      "process.stdout.write(JSON.stringify({tokenDelivery:'private-file-descriptor'}))",
      "setInterval(()=>{},1000)",
    ].join(";");
    const child = spawn(process.execPath, ["-e", source], {
      env: fixture.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", handle.fd],
    });
    await handle.close();
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (childStdout === null || childStderr === null) {
      throw new Error("One-shot process pipes are unavailable");
    }
    let stdout = "";
    let stderr = "";
    childStdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    childStderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    let token = "";
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        token = await readFile(path, "utf8");
        if (
          token.startsWith("swk.") &&
          stdout.includes("private-file-descriptor")
        ) {
          break;
        }
        await new Promise<void>((done) => setTimeout(done, 5));
      }
      expect(token).toMatch(/^swk\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
      const [commandLine, environment] = await Promise.all([
        readFile(`/proc/${String(child.pid)}/cmdline`, "utf8"),
        readFile(`/proc/${String(child.pid)}/environ`, "utf8"),
      ]);
      expect(commandLine).not.toContain(token);
      expect(environment).not.toContain(token);
      expect(stdout).not.toContain(token);
      expect(stderr).not.toContain(token);
      expect(stdout).toContain("private-file-descriptor");
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => undefined);
    }
  });
});
