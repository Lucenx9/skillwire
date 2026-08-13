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
      const cleanup = await Promise.allSettled([
        ...(reference === undefined
          ? []
          : [this.backend.remove(client, reference)]),
        this.issuer.revoke(created.keyId),
      ]);
      if (cleanup.some(({ status }) => status === "rejected")) {
        throw new ClientCredentialRecoveryError(
          "Client credential provisioning failed and narrow cleanup requires recovery",
        );
      }
      throw error;
    }
  }

  async revoke(credential: PersistedClientCredential): Promise<void> {
    const cleanup = await Promise.allSettled([
      this.backend.remove(credential.client, credential.reference),
      this.issuer.revoke(credential.keyId),
    ]);
    if (cleanup.some(({ status }) => status === "rejected")) {
      throw new ClientCredentialRecoveryError(
        "Client credential removal is incomplete and requires recovery",
      );
    }
  }
}
