import { lstatSync, readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  listRepoMemoryOutputSchema,
  loadSkillOutputSchema,
  readSkillResourceOutputSchema,
  searchSkillsOutputSchema,
} from "../src/transport/mcp/schemas.js";

interface Arguments {
  readonly endpoint: URL;
  readonly apiKey: string;
  readonly task: string;
  readonly repositoryHash?: string | undefined;
  readonly verifyMemory: boolean;
}

function valueAfter(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function readApiKey(path: string): string {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4096) {
    throw new Error("API key file is invalid");
  }
  return readFileSync(path, "utf8").trimEnd();
}

function parseArguments(args: readonly string[]): Arguments {
  const endpointValue = valueAfter(args, "--endpoint");
  const task = valueAfter(args, "--task");
  const apiKeyValue = valueAfter(args, "--api-key");
  const apiKeyFile = valueAfter(args, "--api-key-file");
  const repositoryHash = valueAfter(args, "--repository-hash");
  if (
    endpointValue === undefined ||
    task === undefined ||
    (apiKeyValue === undefined) === (apiKeyFile === undefined)
  ) {
    throw new Error(
      "Expected --endpoint, --task, and exactly one API-key source",
    );
  }
  const endpoint = new URL(endpointValue);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("Endpoint must use HTTP or HTTPS");
  }
  if (repositoryHash !== undefined && !/^[0-9a-f]{64}$/.test(repositoryHash)) {
    throw new Error("Repository hash is invalid");
  }
  const verifyMemory = args.includes("--verify-memory");
  if (verifyMemory && repositoryHash === undefined) {
    throw new Error("--verify-memory requires --repository-hash");
  }
  return {
    endpoint,
    apiKey: apiKeyValue ?? readApiKey(apiKeyFile ?? ""),
    task,
    ...(repositoryHash === undefined ? {} : { repositoryHash }),
    verifyMemory,
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const client = new Client({ name: "skillwire-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(args.endpoint, {
    authProvider: { token: () => Promise.resolve(args.apiKey) },
  });
  try {
    await client.connect(transport);
    const search = searchSkillsOutputSchema.parse(
      (
        await client.callTool({
          name: "search_skills",
          arguments: {
            task: args.task,
            limit: 1,
            ...(args.repositoryHash === undefined
              ? {}
              : { repositoryHash: args.repositoryHash }),
          },
        })
      ).structuredContent,
    );
    const selected = search.skills[0];
    if (selected === undefined) throw new Error("Search returned no skills");
    const loaded = loadSkillOutputSchema.parse(
      (
        await client.callTool({
          name: "load_skill",
          arguments: {
            skillId: selected.skillId,
            revision: selected.revision,
            ...(args.repositoryHash === undefined
              ? {}
              : { repositoryHash: args.repositoryHash }),
          },
        })
      ).structuredContent,
    );
    const resourcePath = loaded.resourceManifest[0]?.path;
    if (resourcePath === undefined) throw new Error("Manifest is empty");
    const resource = readSkillResourceOutputSchema.parse(
      (
        await client.callTool({
          name: "read_skill_resource",
          arguments: {
            skillId: loaded.skillId,
            revision: loaded.revision,
            path: resourcePath,
          },
        })
      ).structuredContent,
    );
    let memoryEntryCount: number | undefined;
    if (args.verifyMemory && args.repositoryHash !== undefined) {
      const memory = listRepoMemoryOutputSchema.parse(
        (
          await client.callTool({
            name: "list_repo_memory",
            arguments: { repositoryHash: args.repositoryHash },
          })
        ).structuredContent,
      );
      memoryEntryCount = memory.entries.length;
      if (
        !memory.entries.some(
          (entry) =>
            entry.skillId === loaded.skillId &&
            entry.revision === loaded.revision,
        )
      ) {
        throw new Error(
          "Repository memory did not contain the loaded revision",
        );
      }
    }
    process.stdout.write(
      `${JSON.stringify({
        skillId: loaded.skillId,
        revision: loaded.revision,
        revisionSha256: loaded.revisionSha256,
        resourcePath: resource.path,
        resourceSha256: resource.sha256,
        progressiveCallCount: 3,
        ...(memoryEntryCount === undefined ? {} : { memoryEntryCount }),
      })}\n`,
    );
  } finally {
    await client.close();
  }
}

main().catch(() => {
  process.stderr.write("SkillWire smoke journey failed.\n");
  process.exitCode = 1;
});
