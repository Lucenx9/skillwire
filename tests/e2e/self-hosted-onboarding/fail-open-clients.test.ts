import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import { createTestApplication } from "../../../src/composition.js";
import { BridgeFailure } from "../../../src/credential-bridge/bridge-errors.js";
import { CredentialResolver } from "../../../src/credential-bridge/credential-resolver.js";
import { connectUpstream } from "../../../src/credential-bridge/upstream-client.js";
import {
  SecretToolCredentialStore,
  SecretToolError,
} from "../../../src/onboarding/adapters/credentials/secret-tool.js";
import { ClaudeClientAdapter } from "../../../src/onboarding/adapters/clients/claude.js";
import { CodexClientAdapter } from "../../../src/onboarding/adapters/clients/codex.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { FakeRepositoryMemoryStore } from "../../helpers/memory-store.js";

describe("ordinary normal-profile clients fail open", () => {
  const claudeExecutable = resolve("node_modules/.bin/claude");
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => fixture?.close());

  it.each(["codex", "claude"] as const)(
    "%s remains startable with an optional unreachable SkillWire registration",
    async (client) => {
      fixture = await createOnboardingEnvironment();
      const launcher = resolve(fixture.root, "owned/bin/skillwire");
      await mkdir(resolve(fixture.root, "owned/bin"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(launcher, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
      const adapter =
        client === "codex"
          ? new CodexClientAdapter(
              resolve("node_modules/.bin/codex"),
              fixture.environment,
            )
          : new ClaudeClientAdapter(claudeExecutable, fixture.environment);
      await adapter.addMcp(launcher, "00000000-0000-4000-8000-000000000001");

      const executable =
        client === "codex"
          ? resolve("node_modules/.bin/codex")
          : claudeExecutable;
      const started = spawnSync(executable, ["--version"], {
        cwd: fixture.home,
        env: fixture.environment,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toMatch(
        client === "codex" ? /codex-cli/ : /Claude Code/,
      );
      expect(JSON.stringify(await adapter.readMcp())).not.toMatch(
        /required.*true|authorization|bearer|swk\./i,
      );
    },
    30_000,
  );

  it.each([
    "missing",
    "locked",
    "secret-service-unavailable",
    "fallback-unavailable",
  ] as const)(
    "keeps ordinary clients startable when the credential is %s",
    async (scenario) => {
      fixture = await createOnboardingEnvironment();
      const installationId = "00000000-0000-4000-8000-000000000001";
      const stateRoot = resolve(fixture.xdgStateHome, "skillwire");
      const dataRoot = resolve(fixture.xdgDataHome, "skillwire");
      let resolver = new CredentialResolver(stateRoot, dataRoot);
      if (scenario !== "missing") {
        const installationRoot = resolve(
          stateRoot,
          "installations",
          installationId,
        );
        await mkdir(installationRoot, { recursive: true, mode: 0o700 });
        await writeFile(
          resolve(installationRoot, "bridge-state.json"),
          `${JSON.stringify({
            schemaVersion: "skillwire.bridge-state/v1",
            installationId,
            transport: "unix-domain-socket",
            endpoint: "http://localhost/mcp",
            socketPath: "/tmp/disposable/mcp.sock",
            clients: [
              {
                client: "codex",
                credentialReference:
                  scenario === "fallback-unavailable"
                    ? "restrictive-file:codex"
                    : "secret-service:codex:00000000-0000-4000-8000-000000000002",
              },
            ],
          })}\n`,
          { mode: 0o600 },
        );
        class UnavailableSecretService extends SecretToolCredentialStore {
          override lookup(): Promise<string> {
            return Promise.reject(
              new SecretToolError(
                scenario === "locked" ? "locked" : "unavailable",
                "credential service unavailable",
              ),
            );
          }
        }
        resolver = new CredentialResolver(
          stateRoot,
          dataRoot,
          new UnavailableSecretService(),
          () => Promise.resolve(),
        );
      }
      const failure = await resolver.resolve(installationId, "codex").then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(BridgeFailure);
      expect((failure as BridgeFailure).code).toBe(
        scenario === "missing"
          ? "BRIDGE_STATE_UNAVAILABLE"
          : "BRIDGE_CREDENTIAL_UNAVAILABLE",
      );
      for (const executable of [
        resolve("node_modules/.bin/codex"),
        claudeExecutable,
      ]) {
        expect(
          spawnSync(executable, ["--version"], {
            cwd: fixture.home,
            env: fixture.environment,
            encoding: "utf8",
            timeout: 10_000,
          }).status,
        ).toBe(0);
      }
    },
  );

  it.each([
    ["stopped", "transport"],
    ["unreachable", "transport"],
    ["rejected", "auth"],
    ["timeout", "timeout"],
    ["postgres-unavailable", "transport"],
    ["dns-forbidden", "endpoint"],
    ["incompatible", "contract"],
    ["tool-mismatch", "contract"],
    ["malformed-handshake", "contract"],
  ] as const)(
    "keeps both ordinary clients startable after a real %s bridge failure",
    async (scenario, expectedKind) => {
      fixture = await createOnboardingEnvironment();
      const token = createApiKeyToken().token;
      const { app } = createTestApplication({
        memoryStore: new FakeRepositoryMemoryStore(),
        authenticator: {
          authenticate: (candidate) =>
            Promise.resolve(
              candidate === token
                ? {
                    accountId: "00000000-0000-4000-8000-000000000001",
                    apiKeyId: "00000000-0000-4000-8000-000000000002",
                  }
                : undefined,
            ),
        },
      });
      const appFetch: typeof fetch = async (input, init) => {
        if (scenario === "stopped" || scenario === "unreachable")
          throw new TypeError("fetch failed");
        if (scenario === "rejected")
          return new Response("unauthorized", { status: 401 });
        if (scenario === "postgres-unavailable")
          return new Response("service unavailable", { status: 503 });
        if (scenario === "malformed-handshake")
          return new Response("not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (scenario === "timeout") {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
        }
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set("host", "localhost");
        const response = await app.fetch(new Request(request, { headers }));
        const body = await response.text();
        const altered =
          scenario === "tool-mismatch"
            ? body.replace("forget_repo_memory", "unexpected_tool")
            : body.replace(
                /"instructions"\s*:\s*"(?:\\.|[^"])*"/,
                '"instructions":""',
              );
        return new Response(altered, {
          status: response.status,
          headers: response.headers,
        });
      };

      const failure = await connectUpstream({
        endpoint: new URL(
          scenario === "dns-forbidden"
            ? "http://does-not-resolve.invalid/mcp"
            : "http://localhost/mcp",
        ),
        socketPath: "/tmp/disposable/mcp.sock",
        token,
        fetch: appFetch,
        peerValidator: () => Promise.resolve(),
        deadlineMilliseconds: scenario === "timeout" ? 25 : 1_000,
      }).then(
        async (connection) => {
          await connection.close();
          return undefined;
        },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(BridgeFailure);
      expect((failure as BridgeFailure).code).toMatch(
        expectedKind === "auth"
          ? /AUTH/
          : expectedKind === "timeout"
            ? /DEADLINE/
            : expectedKind === "contract"
              ? /CONTRACT/
              : expectedKind === "endpoint"
                ? /ENDPOINT/
                : /TRANSPORT/,
      );
      for (const [executable, pattern] of [
        [resolve("node_modules/.bin/codex"), /codex-cli/],
        [claudeExecutable, /Claude Code/],
      ] as const) {
        const started = spawnSync(executable, ["--version"], {
          cwd: fixture.home,
          env: fixture.environment,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(started.status, started.stderr).toBe(0);
        expect(started.stdout).toMatch(pattern);
      }
    },
  );

  it.each(["codex", "claude"] as const)(
    "%s starts with a registered bridge executable that has disappeared",
    async (client) => {
      fixture = await createOnboardingEnvironment();
      const missingLauncher = resolve(fixture.root, "missing/skillwire");
      const adapter =
        client === "codex"
          ? new CodexClientAdapter(
              resolve("node_modules/.bin/codex"),
              fixture.environment,
            )
          : new ClaudeClientAdapter(claudeExecutable, fixture.environment);
      await adapter.addMcp(
        missingLauncher,
        "00000000-0000-4000-8000-000000000001",
      );
      const started = spawnSync(
        client === "codex"
          ? resolve("node_modules/.bin/codex")
          : claudeExecutable,
        ["--version"],
        {
          cwd: fixture.home,
          env: fixture.environment,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(started.status, started.stderr).toBe(0);
    },
  );

  it.each(["missing", "disabled", "incompatible"] as const)(
    "Claude starts when the optional activation plugin is %s",
    async (state) => {
      fixture = await createOnboardingEnvironment();
      const settingsRoot = resolve(fixture.home, ".claude");
      await mkdir(settingsRoot, { recursive: true, mode: 0o700 });
      await writeFile(
        resolve(settingsRoot, "settings.json"),
        `${JSON.stringify({
          enabledPlugins:
            state === "missing"
              ? { "unrelated@fixture": true }
              : {
                  "unrelated@fixture": true,
                  "skillwire-autonomous-activation@skillwire":
                    state !== "disabled",
                },
          ...(state === "incompatible"
            ? {
                extraKnownMarketplaces: {
                  skillwire: {
                    source: { source: "directory", path: "/invalid/release" },
                  },
                },
              }
            : {}),
        })}\n`,
        { mode: 0o600 },
      );
      const started = spawnSync(claudeExecutable, ["--version"], {
        cwd: fixture.home,
        env: fixture.environment,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(started.status, started.stderr).toBe(0);
    },
  );
});
