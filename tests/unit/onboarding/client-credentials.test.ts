import { describe, expect, it, vi } from "vitest";

import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import {
  ClientCredentialRecoveryError,
  ClientCredentialService,
} from "../../../src/onboarding/application/client-credentials.js";

describe("per-client credential provisioning", () => {
  it("persists and verifies one client key before returning its non-secret reference", async () => {
    const token = createApiKeyToken().token;
    const service = new ClientCredentialService(
      {
        create: vi.fn().mockResolvedValue({ keyId: "key-codex", token }),
        revoke: vi.fn(),
      },
      {
        store: vi.fn().mockResolvedValue("secret-service:codex"),
        lookup: vi.fn().mockResolvedValue(token),
        remove: vi.fn(),
      },
    );
    await expect(service.provision("codex")).resolves.toEqual({
      client: "codex",
      keyId: "key-codex",
      reference: "secret-service:codex",
    });
  });

  it("removes the new credential and revokes only its new key after readback failure", async () => {
    const token = createApiKeyToken().token;
    const remove = vi.fn().mockResolvedValue(undefined);
    const revoke = vi.fn().mockResolvedValue(undefined);
    const service = new ClientCredentialService(
      {
        create: vi.fn().mockResolvedValue({ keyId: "key-claude", token }),
        revoke,
      },
      {
        store: vi.fn().mockResolvedValue("restrictive-file:claude"),
        lookup: vi.fn().mockResolvedValue(createApiKeyToken().token),
        remove,
      },
    );
    await expect(service.provision("claude")).rejects.toThrow(/verify/i);
    expect(remove).toHaveBeenCalledWith("claude", "restrictive-file:claude");
    expect(revoke).toHaveBeenCalledWith("key-claude");
  });

  it("surfaces recovery-required when either narrow cleanup cannot be proved", async () => {
    const token = createApiKeyToken().token;
    const service = new ClientCredentialService(
      {
        create: vi.fn().mockResolvedValue({ keyId: "key-codex", token }),
        revoke: vi.fn().mockRejectedValue(new Error("revoke failed")),
      },
      {
        store: vi.fn().mockResolvedValue("secret-service:codex"),
        lookup: vi.fn().mockRejectedValue(new Error("lookup failed")),
        remove: vi.fn().mockRejectedValue(new Error("remove failed")),
      },
    );
    await expect(service.provision("codex")).rejects.toBeInstanceOf(
      ClientCredentialRecoveryError,
    );
  });
});
