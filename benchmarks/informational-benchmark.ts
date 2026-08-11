import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

import { loadPublishedCatalog } from "../src/catalog/catalog-loader.js";
import { canonicalJson } from "../src/domain/catalog/canonical-revision.js";

const operationNameSchema = z.enum([
  "search_skills",
  "load_skill",
  "read_skill_resource",
  "list_repo_memory",
  "record_skill_outcome",
  "forget_repo_memory",
]);

const workloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    workloadId: z.literal("skillwire-operation-mix-v1"),
    catalogRelease: z.string().min(1),
    searchCorpus: z.literal("search-ranking-v1"),
    journeyMatrix: z.literal("three-call-journeys-v1"),
    databaseFixture: z.literal("benchmark-fixture-v1"),
    operations: z
      .array(
        z
          .object({
            name: operationNameSchema,
            weight: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .length(6),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.operations.map((entry) => entry.name)).size !== 6) {
      context.addIssue({
        code: "custom",
        message: "Operations must be unique",
      });
    }
    if (
      value.operations.reduce((total, entry) => total + entry.weight, 0) !== 100
    ) {
      context.addIssue({ code: "custom", message: "Weights must total 100" });
    }
  });

const cacheStateSchema = z.enum(["catalog-cold", "catalog-warm"]);
type OperationName = z.infer<typeof operationNameSchema>;
type Workload = z.infer<typeof workloadSchema>;
type CacheState = z.infer<typeof cacheStateSchema>;

interface RawRow {
  readonly sequence: number;
  readonly clientId: number;
  readonly operation: OperationName;
  readonly catalogCacheState: CacheState;
  readonly startedOffsetNs: string;
  readonly durationNs: string;
  readonly resultCode: "ok" | "tool-error" | "exception";
}

interface ConnectedClient {
  readonly client: Client;
  close(): Promise<void>;
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function loadBenchmarkWorkload(projectRoot: string): Workload {
  return workloadSchema.parse(
    loadJson(join(projectRoot, "benchmarks", "operation-mix.v1.json")),
  );
}

export function validateBenchmarkInputs(projectRoot: string): void {
  loadBenchmarkWorkload(projectRoot);
  const schema = z
    .object({
      $schema: z.literal("https://json-schema.org/draft/2020-12/schema"),
      $id: z.literal("https://skillwire.dev/benchmarks/result.schema.json"),
      type: z.literal("object"),
      required: z.array(z.string()).min(5),
      properties: z.record(z.string(), z.unknown()),
    })
    .loose()
    .parse(loadJson(join(projectRoot, "benchmarks", "result.schema.json")));
  for (const field of [
    "schemaVersion",
    "metadata",
    "rawRowsSha256",
    "rawRows",
    "aggregates",
  ]) {
    if (!schema.required.includes(field) || !(field in schema.properties)) {
      throw new Error("Benchmark result schema is incomplete");
    }
  }
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}

function nonNegativeInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return parsed;
}

function repositoryHash(clientId: number): string {
  return createHash("sha256")
    .update(`skillwire-informational-benchmark-${String(clientId)}`)
    .digest("hex");
}

async function connectClient(
  endpoint: URL,
  apiKey: string,
  clientId: number,
): Promise<ConnectedClient> {
  const client = new Client({
    name: `skillwire-benchmark-${String(clientId)}`,
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: { token: () => Promise.resolve(apiKey) },
  });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function executeOperation(
  client: Client,
  operation: OperationName,
  clientId: number,
): Promise<"ok" | "tool-error"> {
  const hash = repositoryHash(clientId);
  if (operation === "record_skill_outcome") {
    await client.callTool({
      name: "load_skill",
      arguments: {
        skillId: "typescript-code-review",
        revision: "1.0.0",
        repositoryHash: hash,
      },
    });
  }
  const request =
    operation === "search_skills"
      ? {
          name: operation,
          arguments: { task: "Review TypeScript type safety", limit: 3 },
        }
      : operation === "load_skill"
        ? {
            name: operation,
            arguments: {
              skillId: "typescript-code-review",
              revision: "1.0.0",
              repositoryHash: hash,
            },
          }
        : operation === "read_skill_resource"
          ? {
              name: operation,
              arguments: {
                skillId: "typescript-code-review",
                revision: "1.0.0",
                path: "references/review-checklist.md",
              },
            }
          : operation === "list_repo_memory" ||
              operation === "forget_repo_memory"
            ? { name: operation, arguments: { repositoryHash: hash } }
            : {
                name: operation,
                arguments: {
                  repositoryHash: hash,
                  skillId: "typescript-code-review",
                  revision: "1.0.0",
                  outcome: "useful",
                },
              };
  const result = await client.callTool(request);
  return result.isError === true ? "tool-error" : "ok";
}

function operationSchedule(workload: Workload): OperationName[] {
  return workload.operations.flatMap((entry) =>
    Array.from({ length: entry.weight }, () => entry.name),
  );
}

function percentile(values: readonly bigint[], fraction: number): string {
  if (values.length === 0) return "0";
  const sorted = values.toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return (sorted[index] ?? 0n).toString();
}

function aggregates(rows: readonly RawRow[]) {
  return operationNameSchema.options.map((operation) => {
    const matching = rows.filter((entry) => entry.operation === operation);
    const durations = matching.map((entry) => BigInt(entry.durationNs));
    const succeeded = matching.filter(
      (entry) => entry.resultCode === "ok",
    ).length;
    return {
      operation,
      attempted: matching.length,
      succeeded,
      failed: matching.length - succeeded,
      p50DurationNs: percentile(durations, 0.5),
      p95DurationNs: percentile(durations, 0.95),
      p99DurationNs: percentile(durations, 0.99),
    };
  });
}

async function runBenchmark(projectRoot: string): Promise<void> {
  const endpointValue = process.env["SKILLWIRE_ENDPOINT"];
  const apiKey = process.env["SKILLWIRE_API_KEY"];
  if (endpointValue === undefined || apiKey === undefined) {
    throw new Error("Benchmark endpoint and API key are required");
  }
  const endpoint = new URL(endpointValue);
  const concurrency = positiveInteger(
    process.env,
    "SKILLWIRE_BENCHMARK_CONCURRENCY",
    25,
    250,
  );
  const warmupCount = nonNegativeInteger(
    process.env,
    "SKILLWIRE_BENCHMARK_WARMUP",
    100,
    100_000,
  );
  const sampleCount = positiveInteger(
    process.env,
    "SKILLWIRE_BENCHMARK_SAMPLES",
    1000,
    1_000_000,
  );
  const catalogCacheState = cacheStateSchema.parse(
    process.env["SKILLWIRE_BENCHMARK_CACHE_STATE"] ?? "catalog-warm",
  );
  const workload = loadBenchmarkWorkload(projectRoot);
  const schedule = operationSchedule(workload);
  const clients = await Promise.all(
    Array.from({ length: concurrency }, (_, index) =>
      connectClient(endpoint, apiKey, index),
    ),
  );
  try {
    for (let index = 0; index < warmupCount; index += 1) {
      const connected = clients[index % clients.length];
      const operation = schedule[index % schedule.length];
      if (connected !== undefined && operation !== undefined) {
        await executeOperation(
          connected.client,
          operation,
          index % concurrency,
        );
      }
    }

    const startedAt = new Date().toISOString();
    const monotonicStart = process.hrtime.bigint();
    const rows: RawRow[] = [];
    let nextSequence = 0;
    await Promise.all(
      clients.map(async (connected, clientId) => {
        for (;;) {
          const sequence = nextSequence;
          nextSequence += 1;
          if (sequence >= sampleCount) return;
          const operation = schedule[sequence % schedule.length];
          if (operation === undefined) return;
          const started = process.hrtime.bigint();
          let resultCode: RawRow["resultCode"];
          try {
            resultCode = await executeOperation(
              connected.client,
              operation,
              clientId,
            );
          } catch {
            resultCode = "exception";
          }
          const ended = process.hrtime.bigint();
          rows.push({
            sequence,
            clientId,
            operation,
            catalogCacheState,
            startedOffsetNs: (started - monotonicStart).toString(),
            durationNs: (ended - started).toString(),
            resultCode,
          });
        }
      }),
    );
    rows.sort((left, right) => left.sequence - right.sequence);
    const loadedCatalog = loadPublishedCatalog(
      projectRoot,
      workload.catalogRelease,
    );
    const packageValue = z
      .object({ version: z.string().min(1) })
      .loose()
      .parse(loadJson(join(projectRoot, "package.json")));
    const report = {
      schemaVersion: 1,
      metadata: {
        workloadId: workload.workloadId,
        catalogRelease: workload.catalogRelease,
        inventorySha256: loadedCatalog.release.inventorySha256,
        advisoryChainHead: loadedCatalog.release.advisoryChainHead,
        searchCorpus: workload.searchCorpus,
        journeyMatrix: workload.journeyMatrix,
        databaseFixture: workload.databaseFixture,
        operatingSystem: `${platform()} ${release()}`,
        architecture: arch(),
        nodeVersion: process.version,
        skillwireVersion: packageValue.version,
        catalogCacheState,
        concurrency,
        warmupCount,
        sampleCount,
        clock: "process.hrtime.bigint",
        startedAt,
        endedAt: new Date().toISOString(),
      },
      rawRowsSha256: createHash("sha256")
        .update(canonicalJson(rows))
        .digest("hex"),
      rawRows: rows,
      aggregates: aggregates(rows),
    };
    const resultsDirectory = join(projectRoot, "benchmarks", "results");
    mkdirSync(resultsDirectory, { recursive: true });
    const fileName = `${startedAt.replaceAll(":", "-")}-${catalogCacheState}.json`;
    const resultPath = join(resultsDirectory, fileName);
    writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    process.stdout.write(
      `${JSON.stringify({
        complete: true,
        resultPath,
        attempted: rows.length,
        failed: rows.filter((entry) => entry.resultCode !== "ok").length,
        rawRowsSha256: report.rawRowsSha256,
      })}\n`,
    );
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  validateBenchmarkInputs(projectRoot);
  if (!process.argv.includes("--validate-only")) {
    await runBenchmark(projectRoot);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  main().catch(() => {
    process.stderr.write("Informational benchmark failed.\n");
    process.exitCode = 1;
  });
}
