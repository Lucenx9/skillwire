import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import {
  loadSkillOutputSchema,
  readSkillResourceOutputSchema,
  searchSkillsOutputSchema,
} from "../../transport/mcp/schemas.js";
import { SKILLWIRE_TOOL_NAMES } from "../../credential-bridge/upstream-client.js";
import type { ClientName } from "../cli/main.js";
import { runCommand } from "../adapters/process/command-runner.js";
import type { ActivationDiagnosticResult } from "./activation-diagnostic.js";

export interface VerifiableRegistration {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ClientVerificationOptions {
  readonly client: ClientName;
  readonly vendorExecutable: string;
  readonly installationId: string;
  readonly registration: VerifiableRegistration;
  readonly expectedLauncher: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly inventory: () => Promise<unknown>;
  readonly signal?: AbortSignal | undefined;
}

export interface ClientVerificationResult {
  readonly evidenceKind: "deterministic";
  readonly client: ClientName;
  readonly tools: readonly string[];
  readonly skillId: string;
  readonly revision: string;
  readonly revisionSha256: string;
  readonly advisoryStatus: string;
  readonly provenanceTrust: string;
  readonly resourceVerified: boolean;
}

export interface CombinedClientVerificationEvidence {
  readonly integrationState: "verified";
  readonly deterministic: ClientVerificationResult;
  readonly automatic: ActivationDiagnosticResult;
}

export function combineClientVerificationEvidence(
  deterministic: ClientVerificationResult,
  automatic: ActivationDiagnosticResult,
): CombinedClientVerificationEvidence {
  if (deterministic.client !== automatic.client) {
    throw new Error("Client verification evidence identities do not match");
  }
  return { integrationState: "verified", deterministic, automatic };
}

export async function verifyClientIntegration(
  options: ClientVerificationOptions,
): Promise<ClientVerificationResult> {
  const expectedArgs = [
    "bridge",
    "--installation",
    options.installationId,
    "--client",
    options.client,
  ];
  if (
    options.registration.command !== options.expectedLauncher ||
    options.registration.args.join("\0") !== expectedArgs.join("\0")
  ) {
    throw new Error(
      "Effective client registration does not match the owned bridge",
    );
  }
  if (
    options.environment["CODEX_HOME"] !== undefined ||
    options.environment["CLAUDE_CONFIG_DIR"] !== undefined
  ) {
    throw new Error("Verification must use the normal client profile");
  }
  const allowedEnvironment = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "PATH",
    "LANG",
    "LC_ALL",
    "DBUS_SESSION_BUS_ADDRESS",
  ] as const;
  const environment = Object.fromEntries(
    allowedEnvironment.flatMap((key) => {
      const value = options.environment[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const expectedVersion =
    options.client === "codex" ? "codex-cli 0.147.0" : "2.1.229 (Claude Code)";
  const version = await runCommand({
    executable: options.vendorExecutable,
    args: ["--version"],
    environment,
    deadlineMilliseconds: 5_000,
    maximumOutputBytes: 4_096,
    signal: options.signal,
  });
  if (version.stdout.trim() !== expectedVersion) {
    throw new Error(`Certified ${options.client} version is unavailable`);
  }
  const before = JSON.stringify(await options.inventory());
  const client = new Client(
    { name: `skillwire-${options.client}-verification`, version: "0.1.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  const transport = new StdioClientTransport({
    command: options.registration.command,
    args: [...options.registration.args],
    env: environment,
    stderr: "pipe",
  });
  const requestOptions = {
    timeout: 5_000,
    maxTotalTimeout: 5_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  try {
    await client.connect(transport, {
      timeout: 10_000,
      maxTotalTimeout: 10_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const listed = await client.listTools(undefined, {
      ...requestOptions,
      cacheMode: "bypass",
    });
    const names = listed.tools.map(({ name }) => name);
    if (names.join("\0") !== SKILLWIRE_TOOL_NAMES.join("\0"))
      throw new Error(
        "Client does not expose the exact SkillWire tool inventory",
      );
    if (
      listed.tools.some(
        ({ outputSchema, description, annotations }) =>
          outputSchema === undefined ||
          description === undefined ||
          annotations === undefined,
      )
    ) {
      throw new Error("Client tool metadata is incomplete");
    }
    const search = searchSkillsOutputSchema.parse(
      (
        await client.callTool(
          {
            name: "search_skills",
            arguments: {
              task: "Review strict TypeScript changes and unsafe type narrowing",
              limit: 1,
              invocationContext: "user-requested",
            },
          },
          requestOptions,
        )
      ).structuredContent,
    );
    const preview = search.skills[0];
    if (preview === undefined)
      throw new Error("Verification search returned no first-party skill");
    const loaded = loadSkillOutputSchema.parse(
      (
        await client.callTool(
          {
            name: "load_skill",
            arguments: { skillId: preview.skillId, revision: preview.revision },
          },
          requestOptions,
        )
      ).structuredContent,
    );
    if (
      loaded.skillId !== preview.skillId ||
      loaded.revision !== preview.revision ||
      loaded.currentAdvisoryStatus !== preview.currentAdvisoryStatus
    ) {
      throw new Error(
        "Exact load identity or advisory status does not match the preview",
      );
    }
    const resource = loaded.resourceManifest[0];
    let resourceVerified = true;
    if (resource !== undefined) {
      const read = readSkillResourceOutputSchema.parse(
        (
          await client.callTool(
            {
              name: "read_skill_resource",
              arguments: {
                skillId: loaded.skillId,
                revision: loaded.revision,
                path: resource.path,
              },
            },
            requestOptions,
          )
        ).structuredContent,
      );
      resourceVerified =
        read.sha256 === resource.sha256 &&
        read.byteLength === resource.byteLength;
      if (!resourceVerified)
        throw new Error("Declared resource integrity did not verify");
    }
    const after = JSON.stringify(await options.inventory());
    if (after !== before)
      throw new Error("Client inventory changed during read-only verification");
    return {
      evidenceKind: "deterministic",
      client: options.client,
      tools: names,
      skillId: loaded.skillId,
      revision: loaded.revision,
      revisionSha256: loaded.revisionSha256,
      advisoryStatus: loaded.currentAdvisoryStatus,
      provenanceTrust: loaded.publishedProvenance.trustAtPublication,
      resourceVerified,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
