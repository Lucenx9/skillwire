import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import { createFakeExecutables } from "../../helpers/onboarding-executables.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { RestrictiveFileCredentialStore } from "../../../src/onboarding/adapters/credentials/restrictive-file.js";
import { SecretToolCredentialStore } from "../../../src/onboarding/adapters/credentials/secret-tool.js";

describe("client credential backends", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it("passes Secret Service values only over stdin and never output/argv/env", async () => {
    fixture = await createOnboardingEnvironment();
    const binaries = await createFakeExecutables(fixture.root);
    const token = createApiKeyToken().token;
    const store = new SecretToolCredentialStore(
      binaries["secret-tool"],
      fixture.environment,
    );
    const result = await store.store(
      "00000000-0000-4000-8000-000000000001",
      "codex",
      token,
    );
    expect(result.reference).toMatch(/^secret-service:codex:[0-9a-f-]{36}$/);
    expect(result.command.stdout).not.toContain(token);
    expect(result.command.stderr).not.toContain(token);
    expect(result.command.stdout).toContain(
      `"stdinBytes":${String(token.length)}`,
    );
    expect(result.command.stdout).not.toContain("swk.");
    expect(result.command.stdout).not.toContain("--password");
    expect(result.command.stdout).toContain('"application","skillwire"');
    expect(result.command.stdout).toContain('"schema","1"');
    expect(result.command.stdout).toContain(
      '"installation","00000000-0000-4000-8000-000000000001"',
    );
    expect(result.command.stdout).toContain('"client","codex"');
    expect(result.command.stdout).toContain('"credential-ref"');
  });

  it("requires explicit fallback confirmation and exact no-follow 0600 invariants", async () => {
    fixture = await createOnboardingEnvironment();
    const installationId = "00000000-0000-4000-8000-000000000001";
    const root = resolve(fixture.stateRoot, "credentials", installationId);
    const store = new RestrictiveFileCredentialStore(
      fixture.stateRoot,
      fixture.stateRoot,
      installationId,
    );
    const token = createApiKeyToken().token;
    await expect(store.store("codex", token, false)).rejects.toThrow(
      /confirm/i,
    );
    const reference = await store.store("codex", token, true);
    expect(await store.lookup(reference)).toBe(token);
    expect(await readFile(resolve(root, "codex.key"), "utf8")).toBe(token);
    await chmod(resolve(root, "codex.key"), 0o644);
    await expect(store.lookup(reference)).rejects.toThrow(/mode/i);

    const otherRoot = resolve(fixture.root, "other");
    await mkdir(otherRoot, { mode: 0o700 });
    await writeFile(resolve(otherRoot, "secret"), token, { mode: 0o600 });
    await chmod(resolve(root, "codex.key"), 0o600);
    await symlink(resolve(otherRoot, "secret"), resolve(root, "claude.key"));
    await expect(store.lookup("restrictive-file:claude")).rejects.toThrow();
  });

  it("classifies a failing Secret Service probe as unavailable", async () => {
    fixture = await createOnboardingEnvironment();
    const binaries = await createFakeExecutables(fixture.root);
    const store = new SecretToolCredentialStore(binaries["secret-tool"], {
      ...fixture.environment,
      SKILLWIRE_FAKE_EXIT: "1",
    });
    await expect(store.probe()).resolves.toBe("unavailable");
  });
});
