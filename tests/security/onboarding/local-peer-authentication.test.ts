import { createServer as createHttpServer, type Server } from "node:http";
import { chmod, mkdir, symlink, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { createAdaptorServer } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import { createTestApplication } from "../../../src/composition.js";
import {
  connectUpstream,
  validateLocalPeerSocket,
} from "../../../src/credential-bridge/upstream-client.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import { FakeRepositoryMemoryStore } from "../../helpers/memory-store.js";

describe("owner-authenticated local credential bridge transport", () => {
  let fixture: OnboardingEnvironment | undefined;
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((done) =>
            server.close(() => {
              done();
            }),
          ),
      ),
    );
    await fixture?.close();
    fixture = undefined;
  });

  it("authenticates the private Unix socket before sending a bearer and never falls back to loopback TCP", async () => {
    fixture = await createOnboardingEnvironment();
    const socketDirectory = resolve(fixture.runtimeRoot, "skillwire-peer");
    const socketPath = resolve(socketDirectory, "mcp.sock");
    await mkdir(socketDirectory, { mode: 0o700 });
    const token = createApiKeyToken().token;
    const observedCandidates: string[] = [];
    const { app } = createTestApplication({
      memoryStore: new FakeRepositoryMemoryStore(),
      authenticator: {
        authenticate: (candidate) => {
          observedCandidates.push(candidate);
          return Promise.resolve(
            candidate === token
              ? {
                  accountId: "00000000-0000-4000-8000-000000000001",
                  apiKeyId: "00000000-0000-4000-8000-000000000002",
                }
              : undefined,
          );
        },
      },
    });
    const unixServer = createAdaptorServer({
      fetch: app.fetch,
      hostname: "localhost",
    }) as Server;
    servers.push(unixServer);
    unixServer.listen(socketPath);
    await new Promise<void>((done, reject) => {
      unixServer.once("listening", done);
      unixServer.once("error", reject);
    });
    await chmod(socketPath, 0o600);

    const tcpAuthorization: string[] = [];
    const malicious = createHttpServer((request, response) => {
      tcpAuthorization.push(request.headers.authorization ?? "");
      response.writeHead(500).end();
    });
    servers.push(malicious);
    malicious.listen(0, "127.0.0.1");
    await new Promise<void>((done) => malicious.once("listening", done));

    const upstream = await connectUpstream({
      endpoint: new URL("http://localhost/mcp"),
      socketPath,
      token,
      deadlineMilliseconds: 2_000,
    });
    expect(upstream.tools).toHaveLength(6);
    expect(observedCandidates).toEqual([token, token]);
    expect(tcpAuthorization).toEqual([]);
    await upstream.close();

    await unlink(socketPath);
    await expect(
      connectUpstream({
        endpoint: new URL("http://localhost/mcp"),
        socketPath,
        token,
        deadlineMilliseconds: 250,
      }),
    ).rejects.toThrow();
    expect(tcpAuthorization).toEqual([]);
  });

  it("rejects permissive directories, socket modes, and symlink substitution", async () => {
    fixture = await createOnboardingEnvironment();
    const socketDirectory = resolve(fixture.runtimeRoot, "skillwire-peer");
    const socketPath = resolve(socketDirectory, "mcp.sock");
    await mkdir(socketDirectory, { mode: 0o700 });
    const server = createHttpServer();
    servers.push(server);
    server.listen(socketPath);
    await new Promise<void>((done) => server.once("listening", done));
    await chmod(socketPath, 0o600);
    await expect(validateLocalPeerSocket(socketPath)).resolves.toBeUndefined();
    await chmod(socketDirectory, 0o755);
    await expect(validateLocalPeerSocket(socketPath)).rejects.toThrow();
    await chmod(socketDirectory, 0o700);
    await chmod(socketPath, 0o666);
    await expect(validateLocalPeerSocket(socketPath)).rejects.toThrow();
    await chmod(socketPath, 0o600);
    await unlink(socketPath);
    await symlink("/tmp/not-a-socket", socketPath);
    await expect(validateLocalPeerSocket(socketPath)).rejects.toThrow();
  });
});
