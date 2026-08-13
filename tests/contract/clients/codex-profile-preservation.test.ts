import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexClientAdapter } from "../../../src/onboarding/adapters/clients/codex.js";
import {
  createClientProfileFixture,
  snapshotTree,
  type ClientProfileFixture,
} from "../../helpers/client-profile-fixtures.js";

const installationId = "00000000-0000-4000-8000-000000000001";

async function exactFileIdentity(path: string): Promise<string> {
  const value = await stat(path, { bigint: true });
  return [value.dev, value.ino, value.size, value.mode, value.mtimeNs].join(
    ":",
  );
}

describe("Codex populated normal-profile preservation", () => {
  let fixture: ClientProfileFixture | undefined;
  afterEach(async () => fixture?.close());

  it("preserves comments and unrelated bytes while adding one optional MCP registration", async () => {
    fixture = await createClientProfileFixture();
    const before = await readFile(fixture.codexConfig, "utf8");
    const repositoryBefore = await snapshotTree(fixture.repository);
    const adapter = new CodexClientAdapter(
      resolve("node_modules/.bin/codex"),
      fixture.environment,
    );

    await adapter.addMcp(fixture.launcher, installationId);
    const after = await readFile(fixture.codexConfig, "utf8");
    const externalIdentity = await exactFileIdentity(fixture.codexConfig);
    const registration = await adapter.readMcp();

    expect(after).toContain(before.trim());
    expect(after.match(/\[mcp_servers\.skillwire\]/g)).toHaveLength(1);
    expect(registration).toMatchObject({
      command: fixture.launcher,
      required: false,
      env: null,
      envVars: [],
      cwd: null,
    });
    expect(await snapshotTree(fixture.repository)).toEqual(repositoryBefore);
    expect(
      (await adapter.reconcileMcp(fixture.launcher, installationId))
        .classification,
    ).toBe("external-equivalent");
    expect(await readFile(fixture.codexConfig, "utf8")).toBe(after);
    expect(await exactFileIdentity(fixture.codexConfig)).toBe(externalIdentity);
  }, 30_000);

  it("never invokes same-name add for an existing entry and leaves it byte-identical", async () => {
    fixture = await createClientProfileFixture();
    const conflicting = `${await readFile(fixture.codexConfig, "utf8")}\n[mcp_servers.skillwire]\ncommand = "/bin/false"\nargs = ["external"]\n`;
    await writeFile(fixture.codexConfig, conflicting, { mode: 0o600 });
    const adapter = new CodexClientAdapter(
      resolve("node_modules/.bin/codex"),
      fixture.environment,
    );

    expect(
      (await adapter.reconcileMcp(fixture.launcher, installationId))
        .classification,
    ).toBe("same-name-conflict");

    await expect(
      adapter.addMcp(fixture.launcher, installationId),
    ).rejects.toThrow(/replace|conflict/i);
    expect(await readFile(fixture.codexConfig, "utf8")).toBe(conflicting);
  });

  it("keeps the independently registered MCP byte-stable across plugin lifecycle", async () => {
    fixture = await createClientProfileFixture();
    const adapter = new CodexClientAdapter(
      resolve("node_modules/.bin/codex"),
      fixture.environment,
    );
    await adapter.addMcp(fixture.launcher, installationId);
    const registrationBefore = await adapter.readMcp();
    const marketplace = resolve("distribution/codex-release-marketplace");

    await adapter.addPlugin(marketplace);
    expect((await adapter.reconcilePlugin(marketplace)).classification).toBe(
      "external-equivalent",
    );
    expect(await adapter.readMcp()).toEqual(registrationBefore);
    await adapter.removePlugin();
    expect(await adapter.readMcp()).toEqual(registrationBefore);
  }, 30_000);

  it("classifies an equivalent alternate name as ambiguous without mutation", async () => {
    fixture = await createClientProfileFixture();
    const before = await readFile(fixture.codexConfig, "utf8");
    const alternate = `${before.trim()}\n\n[mcp_servers.alternate_skillwire]\ncommand = ${JSON.stringify(fixture.launcher)}\nargs = ["bridge", "--installation", ${JSON.stringify(installationId)}, "--client", "codex"]\n`;
    await writeFile(fixture.codexConfig, alternate, { mode: 0o600 });
    const adapter = new CodexClientAdapter(
      resolve("node_modules/.bin/codex"),
      fixture.environment,
    );
    expect(
      (await adapter.reconcileMcp(fixture.launcher, installationId))
        .classification,
    ).toBe("ambiguous");
    expect(await readFile(fixture.codexConfig, "utf8")).toBe(alternate);
  });

  it("does not forward ambient credentials to the client manager", async () => {
    fixture = await createClientProfileFixture();
    const fakeCodex = resolve(fixture.root, "fake-codex");
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        'if [ -n "$SKILLWIRE_TEST_SECRET" ]; then echo LEAKED >&2; exit 99; fi',
        'if [ "$1" = "--version" ]; then echo "codex-cli 0.147.0"; exit 0; fi',
        'if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi',
        "exit 2",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const adapter = new CodexClientAdapter(fakeCodex, {
      ...fixture.environment,
      SKILLWIRE_TEST_SECRET: "ambient-credential-canary",
    });
    await expect(adapter.preflight()).resolves.toMatchObject({ mcp: "absent" });
  });
});
