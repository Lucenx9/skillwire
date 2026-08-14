import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { parseApiKeyToken } from "../../../authentication/api-key-token.js";
import type { ClientName } from "../../cli/main.js";
import {
  validateOwnedDirectory,
  validateOwnedPath,
} from "../filesystem/safe-paths.js";

export type RestrictiveFileReference =
  `restrictive-file:${ClientName}` | `restrictive-file:${ClientName}:${string}`;

export class RestrictiveFileCredentialStore {
  public constructor(
    private readonly dataRoot: string,
    private readonly stateRoot: string,
    private readonly installationId: string,
  ) {}

  private async credentialRoot(): Promise<string> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        this.installationId,
      )
    ) {
      throw new Error("Credential installation identity is invalid");
    }
    const dataRoot = await validateOwnedPath(this.dataRoot, this.stateRoot);
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    await validateOwnedDirectory(dataRoot, this.stateRoot);
    const credentialsRoot = resolve(dataRoot, "credentials");
    await mkdir(credentialsRoot, { mode: 0o700 }).catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    });
    await validateOwnedDirectory(credentialsRoot, dataRoot);
    const root = resolve(credentialsRoot, this.installationId);
    await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    });
    await validateOwnedDirectory(root, credentialsRoot);
    return root;
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async store(
    client: ClientName,
    token: string,
    confirmed: boolean,
  ): Promise<RestrictiveFileReference> {
    if (!confirmed)
      throw new Error(
        "Restrictive-file credential fallback requires explicit confirmation",
      );
    if (parseApiKeyToken(token) === undefined)
      throw new Error("Client credential has an invalid shape");
    const root = await this.credentialRoot();
    const path = resolve(root, `${client}.key`);
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(token, "ascii");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(root);
    return `restrictive-file:${client}`;
  }

  async storeReplacement(
    client: ClientName,
    token: string,
    referenceId: string,
  ): Promise<RestrictiveFileReference> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        referenceId,
      )
    )
      throw new Error("Replacement credential identity is invalid");
    if (parseApiKeyToken(token) === undefined)
      throw new Error("Client credential has an invalid shape");
    const root = await this.credentialRoot();
    const path = resolve(root, `${client}.${referenceId}.key`);
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(token, "ascii");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(root);
    return `restrictive-file:${client}:${referenceId}`;
  }

  private referencePath(reference: RestrictiveFileReference): {
    readonly client: ClientName;
    readonly name: string;
  } {
    const match = /^restrictive-file:(codex|claude)(?::([0-9a-f-]{36}))?$/.exec(
      reference,
    );
    if (match === null) throw new Error("Credential reference is invalid");
    const client = match[1] as ClientName;
    const generation = match[2];
    return {
      client,
      name:
        generation === undefined
          ? `${client}.key`
          : `${client}.${generation}.key`,
    };
  }

  async lookup(reference: RestrictiveFileReference): Promise<string> {
    const { name } = this.referencePath(reference);
    const root = await this.credentialRoot();
    const handle = await open(
      resolve(root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o600
      ) {
        throw new Error(
          "Restrictive credential file has unsafe owner, mode, type, or links",
        );
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > 256)
        throw new Error("Restrictive credential file is too large");
      const token = bytes.toString("ascii");
      if (parseApiKeyToken(token) === undefined)
        throw new Error("Restrictive credential file is invalid");
      return token;
    } finally {
      await handle.close();
    }
  }

  async remove(reference: RestrictiveFileReference): Promise<void> {
    const { name } = this.referencePath(reference);
    const root = await this.credentialRoot();
    const path = await validateOwnedPath(resolve(root, name), root);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== process.getuid?.() ||
        (stats.mode & 0o777) !== 0o600
      )
        throw new Error("Credential ownership is ambiguous");
    } finally {
      await handle.close();
    }
    await unlink(path);
    await this.syncDirectory(root);
  }
}
