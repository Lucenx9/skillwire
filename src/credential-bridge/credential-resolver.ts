import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import { parseApiKeyToken } from "../authentication/api-key-token.js";
import { SecretToolCredentialStore } from "../onboarding/adapters/credentials/secret-tool.js";
import {
  RestrictiveFileCredentialStore,
  type RestrictiveFileReference,
} from "../onboarding/adapters/credentials/restrictive-file.js";
import type { ClientName } from "../onboarding/cli/main.js";
import {
  validateOwnedDirectory,
  validateOwnedPath,
} from "../onboarding/adapters/filesystem/safe-paths.js";
import { BridgeFailure } from "./bridge-errors.js";

const BridgeStateSchema = z
  .object({
    schemaVersion: z.literal("skillwire.bridge-state/v1"),
    installationId: z.uuid(),
    endpoint: z.url(),
    clients: z
      .array(
        z
          .object({
            client: z.enum(["codex", "claude"]),
            credentialReference: z
              .string()
              .regex(
                /^(?:restrictive-file:(?:codex|claude)|secret-service:(?:codex|claude):[0-9a-f-]{36})$/,
              ),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();

export interface ResolvedBridgeCredential {
  readonly endpoint: URL;
  readonly token: string;
}

export class CredentialResolver {
  public constructor(
    private readonly stateRoot: string,
    private readonly dataRoot: string,
    private readonly secretService = new SecretToolCredentialStore(),
  ) {}

  private async resolveUnsafe(
    installationId: string,
    client: ClientName,
  ): Promise<ResolvedBridgeCredential> {
    const installationRoot = await validateOwnedPath(
      resolve(this.stateRoot, "installations", installationId),
      this.stateRoot,
    );
    await validateOwnedDirectory(installationRoot, this.stateRoot);
    const statePath = await validateOwnedPath(
      resolve(installationRoot, "bridge-state.json"),
      installationRoot,
    );
    const handle = await open(
      statePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let state: z.infer<typeof BridgeStateSchema>;
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size > 16 * 1024
      ) {
        throw new Error("Owned bridge state is unsafe");
      }
      state = BridgeStateSchema.parse(
        JSON.parse((await handle.readFile()).toString("utf8")) as unknown,
      );
    } finally {
      await handle.close();
    }
    if (state.installationId !== installationId)
      throw new BridgeFailure("BRIDGE_STATE_UNAVAILABLE");
    const entry = state.clients.find(
      (candidate) => candidate.client === client,
    );
    if (
      entry === undefined ||
      (entry.credentialReference !== `restrictive-file:${client}` &&
        !entry.credentialReference.startsWith(`secret-service:${client}:`))
    ) {
      throw new BridgeFailure("BRIDGE_CREDENTIAL_UNAVAILABLE");
    }
    let token: string;
    try {
      token = entry.credentialReference.startsWith("secret-service:")
        ? await this.secretService.lookup(
            installationId,
            client,
            entry.credentialReference,
          )
        : await new RestrictiveFileCredentialStore(
            this.dataRoot,
            this.dataRoot,
            installationId,
          ).lookup(entry.credentialReference as RestrictiveFileReference);
    } catch (error) {
      throw new BridgeFailure("BRIDGE_CREDENTIAL_UNAVAILABLE", {
        cause: error,
      });
    }
    if (parseApiKeyToken(token) === undefined)
      throw new BridgeFailure("BRIDGE_CREDENTIAL_UNAVAILABLE");
    let endpoint: URL;
    try {
      endpoint = new URL(state.endpoint);
    } catch (error) {
      throw new BridgeFailure("BRIDGE_ENDPOINT_INVALID", { cause: error });
    }
    return { endpoint, token };
  }

  async resolve(
    installationId: string,
    client: ClientName,
  ): Promise<ResolvedBridgeCredential> {
    try {
      return await this.resolveUnsafe(installationId, client);
    } catch (error) {
      if (error instanceof BridgeFailure) throw error;
      throw new BridgeFailure("BRIDGE_STATE_UNAVAILABLE", { cause: error });
    }
  }
}
