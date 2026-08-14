import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { SourceRegistrationService } from "../application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../application/services/source-synchronization-service.js";
import { readDatabaseConfiguration } from "../config.js";
import { assertGitHubCoordinate } from "../domain/external-catalog/types.js";
import { GitHubCommitTreeBlobReader } from "./github/commit-tree-blob-reader.js";
import { GitHubRestClient } from "./github/rest-client.js";
import { createPostgresPool } from "../persistence/postgres/client.js";
import { PostgresExternalCatalogStore } from "../persistence/postgres/external-catalog-store.js";
import { readBoundedGitHubToken } from "../onboarding/adapters/credentials/github-token.js";

export async function runSourceBootstrapCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input: AsyncIterable<Uint8Array | string>,
  fetchImplementation?: typeof fetch,
): Promise<unknown> {
  if (args.length !== 2) throw new Error("INVALID_INPUT");
  const coordinate = assertGitHubCoordinate({
    owner: args[0] ?? "",
    repository: args[1] ?? "",
  });
  const token = await readBoundedGitHubToken(input);
  const pool = createPostgresPool(readDatabaseConfiguration(environment));
  try {
    const store = new PostgresExternalCatalogStore(pool);
    const provider = new GitHubCommitTreeBlobReader(
      new GitHubRestClient({
        token,
        fetchImplementation,
        requestTimeoutMs: 30_000,
        maximumAttempts: 3,
        maximumResponseBytes: 8 * 1024 * 1024,
      }),
    );
    const registration = await new SourceRegistrationService(
      provider,
      store,
    ).add(coordinate, "self-hosted-onboarding", {
      deadline: Date.now() + 300_000,
    });
    const snapshot = await new SourceSynchronizationService(
      provider,
      store,
    ).sync(registration.sourceId, { deadline: Date.now() + 300_000 });
    return {
      schemaVersion: "skillwire.source-bootstrap-result/v1",
      sourceId: registration.sourceId,
      registrationCreated: registration.created,
      snapshotCreated: snapshot.created,
      classifications: snapshot.candidateTraces.map(
        ({ classification }) => classification,
      ),
    };
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runSourceBootstrapCli(process.argv.slice(2), process.env, process.stdin)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "INTERNAL";
      const code = message.includes("RATE_LIMITED")
        ? "RATE_LIMITED"
        : /GITHUB|SOURCE/.test(message)
          ? "SOURCE_UNAVAILABLE"
          : "INTERNAL";
      process.stdout.write(
        `${JSON.stringify({ ok: false, errorCode: code })}\n`,
      );
      process.exitCode = 1;
    });
}
