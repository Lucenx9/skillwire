/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/restrict-template-expressions -- Async fakes mirror production credential interfaces. */
import { describe, expect, it, vi } from "vitest";

import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import { ClientCredentialService } from "../../../src/onboarding/application/client-credentials.js";

describe("independent client credential rotation", () => {
  it("verifies the replacement before revoking the old key", async () => {
    const replacement = createApiKeyToken().token;
    const events: string[] = [];
    const service = new ClientCredentialService(
      {
        create: vi.fn(async (client) => {
          events.push(`create:${client}`);
          return { keyId: "new-codex", token: replacement };
        }),
        revoke: vi.fn(async (keyId) => {
          events.push(`revoke:${keyId}`);
        }),
      },
      {
        store: vi.fn(async (client) => {
          events.push(`store:${client}`);
          return "secret-service:new-codex";
        }),
        lookup: vi.fn(async (client) => {
          events.push(`lookup:${client}`);
          return replacement;
        }),
        remove: vi.fn(async () => undefined),
      },
    );

    await expect(
      service.rotate({
        client: "codex",
        keyId: "old-codex",
        reference: "secret-service:old-codex",
      }),
    ).resolves.toEqual({
      client: "codex",
      keyId: "new-codex",
      reference: "secret-service:new-codex",
    });
    expect(events).toEqual([
      "create:codex",
      "store:codex",
      "lookup:codex",
      "revoke:old-codex",
    ]);
  });

  it("retains the old key and removes only an unverifiable replacement", async () => {
    const replacement = createApiKeyToken().token;
    const revoke = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const service = new ClientCredentialService(
      {
        create: vi.fn().mockResolvedValue({
          keyId: "new-claude",
          token: replacement,
        }),
        revoke,
      },
      {
        store: vi.fn().mockResolvedValue("secret-service:new-claude"),
        lookup: vi.fn().mockResolvedValue(createApiKeyToken().token),
        remove,
      },
    );

    await expect(
      service.rotate({
        client: "claude",
        keyId: "old-claude",
        reference: "secret-service:old-claude",
      }),
    ).rejects.toThrow(/verify/i);
    expect(remove).toHaveBeenCalledWith("claude", "secret-service:new-claude");
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("new-claude");
    expect(revoke).not.toHaveBeenCalledWith("old-claude");
  });

  it("rotates one client without reading, replacing, or revoking its sibling", async () => {
    const replacement = createApiKeyToken().token;
    const sibling = {
      keyId: "claude-stable",
      reference: "secret-service:claude-stable",
    };
    const revoke = vi.fn(async () => undefined);
    const store = vi.fn(async () => "secret-service:codex-replacement");
    const lookup = vi.fn(async () => replacement);
    const service = new ClientCredentialService(
      {
        create: vi.fn(async (client) => ({
          keyId: `${client}-replacement`,
          token: replacement,
        })),
        revoke,
      },
      { store, lookup, remove: vi.fn(async () => undefined) },
    );

    await service.rotate({
      client: "codex",
      keyId: "codex-old",
      reference: "secret-service:codex-old",
    });

    expect(store).toHaveBeenCalledWith("codex", replacement);
    expect(lookup).toHaveBeenCalledWith(
      "codex",
      "secret-service:codex-replacement",
    );
    expect(revoke).toHaveBeenCalledWith("codex-old");
    expect(
      JSON.stringify([store.mock.calls, lookup.mock.calls, revoke.mock.calls]),
    ).not.toContain(sibling.keyId);
    expect(
      JSON.stringify([store.mock.calls, lookup.mock.calls, revoke.mock.calls]),
    ).not.toContain(sibling.reference);
  });
});
