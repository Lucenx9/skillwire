import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { parseApiKeyToken } from "../../../authentication/api-key-token.js";
import {
  CommandFailure,
  runCommand,
  type CommandResult,
} from "../process/command-runner.js";
import type { ClientName } from "../../cli/main.js";
import { z } from "zod";

export type SecretToolFailure =
  | "unavailable"
  | "locked"
  | "not-found"
  | "invalid"
  | "timeout"
  | "clear-failed";

export class SecretToolError extends Error {
  public constructor(
    readonly kind: SecretToolFailure,
    message: string,
  ) {
    super(message);
    this.name = "SecretToolError";
  }
}

function credentialReferenceId(reference: string, client: ClientName): string {
  const match = /^secret-service:(codex|claude):([0-9a-f-]{36})$/.exec(
    reference,
  );
  if (match?.[1] !== client || !z.uuid().safeParse(match[2]).success) {
    throw new SecretToolError(
      "invalid",
      "Secret Service credential reference is invalid",
    );
  }
  return match[2] ?? "";
}

function attributes(
  installationId: string,
  client: ClientName,
  referenceId: string,
): string[] {
  z.uuid().parse(installationId);
  z.uuid().parse(referenceId);
  return [
    "application",
    "skillwire",
    "schema",
    "1",
    "installation",
    installationId,
    "client",
    client,
    "credential-ref",
    referenceId,
  ];
}

export class SecretToolCredentialStore {
  public constructor(
    private readonly executable = "/usr/bin/secret-tool",
    private readonly environment: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      DBUS_SESSION_BUS_ADDRESS: process.env["DBUS_SESSION_BUS_ADDRESS"],
      XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"],
    },
  ) {
    if (!isAbsolute(executable))
      throw new Error("secret-tool executable must be absolute");
  }

  async probe(
    signal?: AbortSignal,
  ): Promise<"available" | "locked" | "unavailable"> {
    const probeId = randomUUID();
    const probeSecret = randomBytes(32).toString("base64url");
    const probeAttributes = ["skillwire-probe", probeId];
    try {
      await runCommand({
        executable: resolve(this.executable),
        args: [
          "store",
          "--label",
          "SkillWire availability probe",
          ...probeAttributes,
        ],
        environment: this.environment,
        stdin: probeSecret,
        deadlineMilliseconds: 2_000,
        signal,
      });
      const lookup = await runCommand({
        executable: resolve(this.executable),
        args: ["lookup", ...probeAttributes],
        environment: this.environment,
        deadlineMilliseconds: 2_000,
        maximumOutputBytes: 256,
        allowSensitiveStdout: true,
        signal,
      });
      const value = lookup.stdout.endsWith("\n")
        ? lookup.stdout.slice(0, -1)
        : lookup.stdout;
      const expected = Buffer.from(probeSecret);
      const actual = Buffer.from(value);
      return expected.byteLength === actual.byteLength &&
        timingSafeEqual(expected, actual)
        ? "available"
        : "unavailable";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return /locked|prompt/i.test(message) ? "locked" : "unavailable";
    } finally {
      await runCommand({
        executable: resolve(this.executable),
        args: ["clear", ...probeAttributes],
        environment: this.environment,
        acceptExitCodes: [0, 1],
        deadlineMilliseconds: 2_000,
      }).catch(() => undefined);
    }
  }

  async store(
    installationId: string,
    client: ClientName,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ reference: string; command: CommandResult }> {
    if (parseApiKeyToken(token) === undefined)
      throw new SecretToolError(
        "invalid",
        "Client credential has an invalid shape",
      );
    const referenceId = randomUUID();
    const command = await runCommand({
      executable: resolve(this.executable),
      args: [
        "store",
        "--label",
        `SkillWire ${client} API key`,
        ...attributes(installationId, client, referenceId),
      ],
      environment: this.environment,
      stdin: token,
      deadlineMilliseconds: 5_000,
      maximumOutputBytes: 16 * 1024,
      signal,
    });
    return {
      reference: `secret-service:${client}:${referenceId}`,
      command,
    };
  }

  async lookup(
    installationId: string,
    client: ClientName,
    reference: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const credentialId = credentialReferenceId(reference, client);
    const credentialAttributes = attributes(
      installationId,
      client,
      credentialId,
    );
    let result: CommandResult;
    try {
      result = await runCommand({
        executable: resolve(this.executable),
        args: ["lookup", ...credentialAttributes],
        environment: this.environment,
        deadlineMilliseconds: 3_000,
        maximumOutputBytes: 256,
        allowSensitiveStdout: true,
        signal,
      });
    } catch (error) {
      if (error instanceof CommandFailure && error.kind === "deadline") {
        throw new SecretToolError(
          "timeout",
          "Secret Service credential lookup timed out",
        );
      }
      try {
        const search = await runCommand({
          executable: resolve(this.executable),
          args: ["search", "--all", ...credentialAttributes],
          environment: this.environment,
          acceptExitCodes: [0, 1],
          deadlineMilliseconds: 2_000,
          maximumOutputBytes: 16 * 1024,
          signal,
        });
        if (/locked|collection.*lock/i.test(search.stderr)) {
          throw new SecretToolError(
            "locked",
            "Secret Service credential collection is locked",
          );
        }
        if (search.code === 0) {
          throw new SecretToolError(
            "not-found",
            "Client credential is unavailable from Secret Service",
          );
        }
      } catch (classificationError) {
        if (classificationError instanceof SecretToolError)
          throw classificationError;
        if (
          classificationError instanceof CommandFailure &&
          classificationError.kind === "deadline"
        ) {
          throw new SecretToolError(
            "timeout",
            "Secret Service credential lookup timed out",
          );
        }
        throw new SecretToolError(
          "unavailable",
          "Secret Service credential backend is unavailable",
        );
      }
      throw new SecretToolError(
        "unavailable",
        "Secret Service credential backend is unavailable",
      );
    }
    const token = result.stdout.endsWith("\n")
      ? result.stdout.slice(0, -1)
      : result.stdout;
    if (parseApiKeyToken(token) === undefined)
      throw new SecretToolError(
        "invalid",
        "Secret Service returned an invalid client credential",
      );
    return token;
  }

  async clear(
    installationId: string,
    client: ClientName,
    reference: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const credentialId = credentialReferenceId(reference, client);
    try {
      await runCommand({
        executable: resolve(this.executable),
        args: ["clear", ...attributes(installationId, client, credentialId)],
        environment: this.environment,
        acceptExitCodes: [0, 1],
        deadlineMilliseconds: 3_000,
        signal,
      });
    } catch {
      throw new SecretToolError(
        "clear-failed",
        "Secret Service credential clear failed",
      );
    }
  }
}
