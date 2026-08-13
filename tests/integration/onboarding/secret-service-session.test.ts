import { access, readFile, stat } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createSecretServiceSession } from "../../helpers/secret-service-session.js";
import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import {
  SecretToolCredentialStore,
  SecretToolError,
} from "../../../src/onboarding/adapters/credentials/secret-tool.js";
import { RestrictiveFileCredentialStore } from "../../../src/onboarding/adapters/credentials/restrictive-file.js";
import { selectCredentialBackend } from "../../../src/onboarding/application/production-setup.js";

const installationId = "00000000-0000-4000-8000-000000000001";

async function hasRealSecretServiceProvider(): Promise<boolean> {
  try {
    await Promise.all([
      access("/usr/bin/secret-tool"),
      access("/usr/bin/gnome-keyring-daemon"),
      access("/usr/bin/dbus-daemon"),
      access("/usr/bin/dbus-send"),
      access("/usr/bin/gdbus"),
    ]);
    return true;
  } catch {
    return false;
  }
}

describe("real isolated Secret Service session", async () => {
  const enabled =
    process.env["SKILLWIRE_RUN_SECRET_SERVICE_INTEGRATION"] === "1";
  const available = enabled && (await hasRealSecretServiceProvider());
  let session:
    Awaited<ReturnType<typeof createSecretServiceSession>> | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  it.skipIf(!available)(
    "uses the production backend for distinct fresh-process client credentials and clear",
    async () => {
      session = await createSecretServiceSession();
      const store = new SecretToolCredentialStore(
        "/usr/bin/secret-tool",
        session.environment,
      );
      const codex = createApiKeyToken().token;
      const claude = createApiKeyToken().token;
      expect(await store.probe()).toBe("available");
      const codexStored = await store.store(installationId, "codex", codex);
      const claudeStored = await store.store(installationId, "claude", claude);
      expect(
        codexStored.command.stdout + codexStored.command.stderr,
      ).not.toContain(codex);
      expect(
        claudeStored.command.stdout + claudeStored.command.stderr,
      ).not.toContain(claude);
      expect(
        await store.lookup(installationId, "codex", codexStored.reference),
      ).toBe(codex);
      expect(
        await store.lookup(installationId, "claude", claudeStored.reference),
      ).toBe(claude);
      await store.clear(installationId, "codex", codexStored.reference);
      await expect(
        store.lookup(installationId, "codex", codexStored.reference),
      ).rejects.toMatchObject({
        kind: "not-found",
      });
      expect(
        await store.lookup(installationId, "claude", claudeStored.reference),
      ).toBe(claude);
    },
    30_000,
  );

  it.skipIf(!available)(
    "classifies a locked collection and an unavailable provider without disclosure",
    async () => {
      session = await createSecretServiceSession();
      const store = new SecretToolCredentialStore(
        "/usr/bin/secret-tool",
        session.environment,
      );
      const token = createApiKeyToken().token;
      const stored = await store.store(installationId, "codex", token);
      const locked = await session.run("/usr/bin/gdbus", [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.secrets",
        "--object-path",
        "/org/freedesktop/secrets",
        "--method",
        "org.freedesktop.Secret.Service.Lock",
        "['/org/freedesktop/secrets/collection/login']",
      ]);
      expect(locked.code).toBe(0);
      await expect(
        store.lookup(installationId, "codex", stored.reference),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(SecretToolError);
        expect((error as SecretToolError).kind).toBe("locked");
        expect((error as Error).message).not.toContain(token);
        return true;
      });
      expect(await store.probe()).toBe("locked");
      const unavailableEnvironment = { ...session.environment };
      await session.close();
      session = undefined;
      const unavailable = new SecretToolCredentialStore(
        "/usr/bin/secret-tool",
        unavailableEnvironment,
      );
      expect(await unavailable.probe()).toBe("unavailable");
      await expect(
        unavailable.lookup(installationId, "codex", stored.reference),
      ).rejects.toMatchObject({
        kind: "unavailable",
      });
    },
    30_000,
  );

  it.skipIf(!available)(
    "recreates the provider and bus from retained XDG state and prefers it over fallback",
    async () => {
      session = await createSecretServiceSession();
      const root = session.root;
      const password = session.password;
      const token = createApiKeyToken().token;
      const initial = new SecretToolCredentialStore(
        "/usr/bin/secret-tool",
        session.environment,
      );
      const stored = await initial.store(installationId, "claude", token);
      await session.close({ retainXdg: true });
      session = await createSecretServiceSession({ root, password });
      const recreated = new SecretToolCredentialStore(
        "/usr/bin/secret-tool",
        session.environment,
      );
      expect(
        await recreated.lookup(installationId, "claude", stored.reference),
      ).toBe(token);

      const fallback = new RestrictiveFileCredentialStore(
        `${root}/data/skillwire`,
        `${root}/data`,
        installationId,
      );
      const fallbackToken = createApiKeyToken().token;
      const reference = await fallback.store("claude", fallbackToken, true);
      expect(await recreated.probe()).toBe("available");
      expect(await selectCredentialBackend("claude", session.environment)).toBe(
        "secret-service",
      );
      expect(
        await recreated.lookup(installationId, "claude", stored.reference),
      ).toBe(token);
      expect(await fallback.lookup(reference)).toBe(fallbackToken);
      const fallbackPath = `${root}/data/skillwire/credentials/${installationId}/claude.key`;
      expect((await stat(fallbackPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(fallbackPath, "utf8")).toBe(fallbackToken);
    },
    30_000,
  );
});
