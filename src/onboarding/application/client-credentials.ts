import { timingSafeEqual } from "node:crypto";

import { parseApiKeyToken } from "../../authentication/api-key-token.js";
import type { ClientName } from "../cli/main.js";

export interface CreatedClientKey {
  readonly keyId: string;
  readonly token: string;
}

export interface ClientKeyIssuer {
  create(client: ClientName): Promise<CreatedClientKey>;
  revoke(keyId: string): Promise<void>;
}

export interface ClientCredentialBackend {
  store(client: ClientName, token: string): Promise<string>;
  lookup(client: ClientName, reference: string): Promise<string>;
  remove(client: ClientName, reference: string): Promise<void>;
}

export interface PersistedClientCredential {
  readonly client: ClientName;
  readonly keyId: string;
  readonly reference: string;
}

export class ClientCredentialRecoveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ClientCredentialRecoveryError";
  }
}

export class ClientCredentialService {
  public constructor(
    private readonly issuer: ClientKeyIssuer,
    private readonly backend: ClientCredentialBackend,
  ) {}

  private async revokeThenRemove(
    credential: PersistedClientCredential,
  ): Promise<void> {
    await this.issuer.revoke(credential.keyId);
    await this.backend.remove(credential.client, credential.reference);
  }

  async provision(client: ClientName): Promise<PersistedClientCredential> {
    const created = await this.issuer.create(client);
    if (parseApiKeyToken(created.token) === undefined)
      throw new Error("Administration returned an invalid client key");
    let reference: string | undefined;
    try {
      reference = await this.backend.store(client, created.token);
      const resolved = await this.backend.lookup(client, reference);
      const expected = Buffer.from(created.token);
      const actual = Buffer.from(resolved);
      if (
        expected.byteLength !== actual.byteLength ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error("Persisted client credential did not verify");
      return { client, keyId: created.keyId, reference };
    } catch (error) {
      try {
        await this.issuer.revoke(created.keyId);
        if (reference !== undefined)
          await this.backend.remove(client, reference);
      } catch {
        throw new ClientCredentialRecoveryError(
          "Client credential provisioning failed and narrow cleanup requires recovery",
        );
      }
      throw error;
    }
  }

  async rotate(
    current: PersistedClientCredential,
    transition?: {
      readonly activate: (
        replacement: PersistedClientCredential,
      ) => Promise<void>;
      readonly verify: (
        replacement: PersistedClientCredential,
      ) => Promise<void>;
      readonly rollback: (current: PersistedClientCredential) => Promise<void>;
    },
  ): Promise<PersistedClientCredential> {
    const replacement = await this.provision(current.client);
    try {
      await transition?.activate(replacement);
      await transition?.verify(replacement);
    } catch (error) {
      try {
        await transition?.rollback(current);
        await this.revokeThenRemove(replacement);
      } catch {
        throw new ClientCredentialRecoveryError(
          "Client key rotation failed and replacement cleanup requires recovery",
        );
      }
      throw new Error(
        "Client key rotation could not activate its replacement",
        {
          cause: error,
        },
      );
    }
    try {
      await this.issuer.revoke(current.keyId);
    } catch (error) {
      try {
        await transition?.rollback(current);
        await this.revokeThenRemove(replacement);
      } catch {
        throw new ClientCredentialRecoveryError(
          "Client key rotation failed and replacement cleanup requires recovery",
        );
      }
      throw new Error("Client key rotation could not revoke the old key", {
        cause: error,
      });
    }
    try {
      await this.backend.remove(current.client, current.reference);
    } catch {
      throw new ClientCredentialRecoveryError(
        "Client key rotation succeeded but old credential cleanup requires recovery",
      );
    }
    return replacement;
  }

  async revoke(credential: PersistedClientCredential): Promise<void> {
    try {
      await this.revokeThenRemove(credential);
    } catch {
      throw new ClientCredentialRecoveryError(
        "Client credential removal is incomplete and requires recovery",
      );
    }
  }
}
