import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  arch,
  availableParallelism,
  cpus,
  platform,
  release,
  totalmem,
} from "node:os";
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

const digestSchema = z.string().regex(/^(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/);
const rawRowSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    clientId: z.number().int().nonnegative(),
    operation: operationNameSchema,
    catalogCacheState: cacheStateSchema,
    startedOffsetNs: z.string().regex(/^[0-9]+$/),
    durationNs: z.string().regex(/^[0-9]+$/),
    resultCode: z.enum(["ok", "tool-error", "exception"]),
  })
  .strict();
const aggregateSchema = z
  .object({
    operation: operationNameSchema,
    attempted: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    p50DurationNs: z.string().regex(/^[0-9]+$/),
    p95DurationNs: z.string().regex(/^[0-9]+$/),
    p99DurationNs: z.string().regex(/^[0-9]+$/),
  })
  .strict();
const benchmarkMetadataSchema = z
  .object({
    workloadId: z.literal("skillwire-operation-mix-v1"),
    catalogRelease: z.string().min(1),
    inventorySha256: z.string().regex(/^[0-9a-f]{64}$/),
    revisionBundleSha256s: z.record(
      z.string().min(1),
      z.string().regex(/^[0-9a-f]{64}$/),
    ),
    advisoryChainHead: z.string().regex(/^[0-9a-f]{64}$/),
    searchCorpus: z.literal("search-ranking-v1"),
    searchCorpusSha256: z.string().regex(/^[0-9a-f]{64}$/),
    journeyMatrix: z.literal("three-call-journeys-v1"),
    journeyMatrixSha256: z.string().regex(/^[0-9a-f]{64}$/),
    operationMixSha256: z.string().regex(/^[0-9a-f]{64}$/),
    databaseFixture: z.literal("benchmark-fixture-v1"),
    operatingSystem: z.string().min(1),
    kernel: z.string().min(1),
    architecture: z.string().min(1),
    cpuModel: z.string().min(1),
    cpuAllocation: z.number().int().positive(),
    memoryLimitBytes: z.string().regex(/^[0-9]+$/),
    dockerVersion: z.string().min(1),
    composeVersion: z.string().min(1),
    imageDigests: z
      .object({
        skillwire: digestSchema,
        postgres: digestSchema,
        benchmarkClient: digestSchema,
      })
      .strict(),
    nodeVersion: z.string().min(1),
    dependencyVersions: z
      .object({
        pnpm: z.string().min(1),
        postgres: z.string().min(1),
        mcpClient: z.string().min(1),
        mcpServer: z.string().min(1),
        hono: z.string().min(1),
        zod: z.string().min(1),
      })
      .strict(),
    skillwireVersion: z.string().min(1),
    applicationCommit: z.string().regex(/^[0-9a-f]{40}$/),
    benchmarkRunnerSha256: z.string().regex(/^[0-9a-f]{64}$/),
    catalogCacheState: cacheStateSchema,
    concurrency: z.number().int().positive(),
    warmupCount: z.number().int().nonnegative(),
    sampleCount: z.number().int().positive(),
    fixtureResetCount: z.literal(2),
    clock: z.literal("process.hrtime.bigint"),
    availabilityContinuous: z.boolean(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
  })
  .strict();
const benchmarkResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    metadata: benchmarkMetadataSchema,
    rawRowsSha256: z.string().regex(/^[0-9a-f]{64}$/),
    rawRows: z.array(rawRowSchema),
    aggregates: z.array(aggregateSchema).length(6),
  })
  .strict();

const requiredMetadataFields = Object.keys(
  benchmarkMetadataSchema.shape,
) as readonly string[];

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function schemaRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Benchmark JSON schema is invalid");
  }
  return value as Record<string, unknown>;
}

function validateJsonSchema(
  schemaValue: unknown,
  value: unknown,
  path = "$",
): void {
  const schema = schemaRecord(schemaValue);
  if (
    schema["const"] !== undefined &&
    canonicalJson(value) !== canonicalJson(schema["const"])
  ) {
    throw new Error(`Benchmark result does not match schema at ${path}`);
  }
  if (
    Array.isArray(schema["enum"]) &&
    !schema["enum"].some(
      (entry) => canonicalJson(entry) === canonicalJson(value),
    )
  ) {
    throw new Error(`Benchmark result does not match schema at ${path}`);
  }
  const type = schema["type"];
  if (type === "object") {
    const object = schemaRecord(value);
    const required = Array.isArray(schema["required"])
      ? schema["required"]
      : [];
    for (const field of required) {
      if (typeof field !== "string" || !(field in object)) {
        throw new Error(`Benchmark result is missing ${path}.${String(field)}`);
      }
    }
    const properties = schemaRecord(schema["properties"] ?? {});
    const additional = schema["additionalProperties"];
    for (const [key, entry] of Object.entries(object)) {
      if (key in properties) {
        validateJsonSchema(properties[key], entry, `${path}.${key}`);
      } else if (additional === false) {
        throw new Error(`Benchmark result contains unexpected ${path}.${key}`);
      } else if (typeof additional === "object" && additional !== null) {
        validateJsonSchema(additional, entry, `${path}.${key}`);
      }
    }
    if (
      typeof schema["minProperties"] === "number" &&
      Object.keys(object).length < schema["minProperties"]
    ) {
      throw new Error(`Benchmark result has too few properties at ${path}`);
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`Benchmark result is not an array at ${path}`);
    }
    if (schema["items"] !== undefined) {
      value.forEach((entry, index) => {
        validateJsonSchema(schema["items"], entry, `${path}[${String(index)}]`);
      });
    }
    return;
  }
  if (type === "string") {
    if (typeof value !== "string") {
      throw new Error(`Benchmark result is not a string at ${path}`);
    }
    if (
      typeof schema["minLength"] === "number" &&
      value.length < schema["minLength"]
    ) {
      throw new Error(`Benchmark result string is too short at ${path}`);
    }
    if (
      typeof schema["pattern"] === "string" &&
      !new RegExp(schema["pattern"], "u").test(value)
    ) {
      throw new Error(`Benchmark result string is invalid at ${path}`);
    }
    if (schema["format"] === "date-time" && Number.isNaN(Date.parse(value))) {
      throw new Error(`Benchmark result date is invalid at ${path}`);
    }
    return;
  }
  if (type === "integer") {
    if (!Number.isInteger(value)) {
      throw new Error(`Benchmark result is not an integer at ${path}`);
    }
    if (
      typeof schema["minimum"] === "number" &&
      (value as number) < schema["minimum"]
    ) {
      throw new Error(`Benchmark result integer is too small at ${path}`);
    }
    return;
  }
  if (type === "boolean" && typeof value !== "boolean") {
    throw new Error(`Benchmark result is not a boolean at ${path}`);
  }
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
  const metadata = z
    .object({
      type: z.literal("object"),
      required: z.array(z.string()),
      properties: z.record(z.string(), z.unknown()),
    })
    .loose()
    .parse(schema.properties["metadata"]);
  for (const field of requiredMetadataFields) {
    if (!metadata.required.includes(field) || !(field in metadata.properties)) {
      throw new Error("Benchmark metadata schema is incomplete");
    }
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value === "unreported") {
    throw new Error(`${name} is required for a complete benchmark report`);
  }
  return value;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function memoryLimitBytes(): string {
  try {
    const cgroupLimit = readFileSync(
      "/sys/fs/cgroup/memory.max",
      "utf8",
    ).trim();
    if (/^[0-9]+$/.test(cgroupLimit)) return cgroupLimit;
  } catch {
    // Non-cgroup local runs use the operating-system memory total.
  }
  return String(totalmem());
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

async function resetDatabaseFixture(
  clients: readonly ConnectedClient[],
): Promise<void> {
  await Promise.all(
    clients.map(async (connected, clientId) => {
      const result = await connected.client.callTool({
        name: "forget_repo_memory",
        arguments: { repositoryHash: repositoryHash(clientId) },
      });
      if (result.isError === true) {
        throw new Error("Benchmark database fixture reset failed");
      }
    }),
  );
}

async function serviceReady(endpoint: URL): Promise<boolean> {
  const readinessUrl = new URL(endpoint);
  readinessUrl.pathname = "/health/ready";
  readinessUrl.search = "";
  try {
    return (await fetch(readinessUrl, { signal: AbortSignal.timeout(5000) }))
      .ok;
  } catch {
    return false;
  }
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
  const applicationCommit = requiredEnvironment("SKILLWIRE_BENCHMARK_COMMIT");
  const dockerVersion = requiredEnvironment(
    "SKILLWIRE_BENCHMARK_DOCKER_VERSION",
  );
  const composeVersion = requiredEnvironment(
    "SKILLWIRE_BENCHMARK_COMPOSE_VERSION",
  );
  const skillwireImageDigest = requiredEnvironment(
    "SKILLWIRE_BENCHMARK_SKILLWIRE_IMAGE_DIGEST",
  );
  const postgresImageDigest = requiredEnvironment(
    "SKILLWIRE_BENCHMARK_POSTGRES_IMAGE_DIGEST",
  );
  const benchmarkClientImageDigest = requiredEnvironment(
    "SKILLWIRE_BENCHMARK_CLIENT_IMAGE_DIGEST",
  );
  const postgresVersion = requiredEnvironment(
    "SKILLWIRE_BENCHMARK_POSTGRES_VERSION",
  );
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
  const requireSuccessfulOperations = z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .parse(process.env["SKILLWIRE_BENCHMARK_REQUIRE_SUCCESS"] ?? "false");
  const workload = loadBenchmarkWorkload(projectRoot);
  const schedule = operationSchedule(workload);
  const availabilityAtStart = await serviceReady(endpoint);
  const clients = await Promise.all(
    Array.from({ length: concurrency }, (_, index) =>
      connectClient(endpoint, apiKey, index),
    ),
  );
  try {
    await resetDatabaseFixture(clients);
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
    await resetDatabaseFixture(clients);

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
      .object({
        version: z.string().min(1),
        packageManager: z.string().regex(/^pnpm@.+$/),
        dependencies: z.record(z.string(), z.string().min(1)),
        devDependencies: z.record(z.string(), z.string().min(1)),
      })
      .loose()
      .parse(loadJson(join(projectRoot, "package.json")));
    const dependency = (name: string): string => {
      const version =
        packageValue.dependencies[name] ?? packageValue.devDependencies[name];
      if (version === undefined) throw new Error(`Missing dependency ${name}`);
      return version;
    };
    const endedAt = new Date().toISOString();
    const availabilityAtEnd = await serviceReady(endpoint);
    const operationMixPath = join(
      projectRoot,
      "benchmarks",
      "operation-mix.v1.json",
    );
    const benchmarkRunnerPath = join(
      projectRoot,
      "benchmarks",
      "informational-benchmark.ts",
    );
    const report = benchmarkResultSchema.parse({
      schemaVersion: 1,
      metadata: {
        workloadId: workload.workloadId,
        catalogRelease: workload.catalogRelease,
        inventorySha256: loadedCatalog.release.inventorySha256,
        revisionBundleSha256s: Object.fromEntries(
          loadedCatalog.revisions.map((revision) => [
            `${revision.skillId}@${revision.revision}`,
            revision.bundleSha256,
          ]),
        ),
        advisoryChainHead: loadedCatalog.release.advisoryChainHead,
        searchCorpus: workload.searchCorpus,
        searchCorpusSha256: sha256File(
          join(projectRoot, "evaluation", "search-ranking.v1.json"),
        ),
        journeyMatrix: workload.journeyMatrix,
        journeyMatrixSha256: sha256File(
          join(projectRoot, "evaluation", "three-call-journeys.v1.json"),
        ),
        operationMixSha256: sha256File(operationMixPath),
        databaseFixture: workload.databaseFixture,
        operatingSystem: platform(),
        kernel: release(),
        architecture: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown-cpu",
        cpuAllocation: availableParallelism(),
        memoryLimitBytes: memoryLimitBytes(),
        dockerVersion,
        composeVersion,
        imageDigests: {
          skillwire: skillwireImageDigest,
          postgres: postgresImageDigest,
          benchmarkClient: benchmarkClientImageDigest,
        },
        nodeVersion: process.version,
        dependencyVersions: {
          pnpm: packageValue.packageManager.slice("pnpm@".length),
          postgres: postgresVersion,
          mcpClient: dependency("@modelcontextprotocol/client"),
          mcpServer: dependency("@modelcontextprotocol/server"),
          hono: dependency("hono"),
          zod: dependency("zod"),
        },
        skillwireVersion: packageValue.version,
        applicationCommit,
        benchmarkRunnerSha256: sha256File(benchmarkRunnerPath),
        catalogCacheState,
        concurrency,
        warmupCount,
        sampleCount,
        fixtureResetCount: 2,
        clock: "process.hrtime.bigint",
        availabilityContinuous:
          availabilityAtStart &&
          availabilityAtEnd &&
          rows.every((entry) => entry.resultCode !== "exception"),
        startedAt,
        endedAt,
      },
      rawRowsSha256: createHash("sha256")
        .update(canonicalJson(rows))
        .digest("hex"),
      rawRows: rows,
      aggregates: aggregates(rows),
    });
    if (
      requireSuccessfulOperations &&
      rows.some((entry) => entry.resultCode !== "ok")
    ) {
      throw new Error("Functional benchmark smoke contained failed operations");
    }
    validateJsonSchema(
      loadJson(join(projectRoot, "benchmarks", "result.schema.json")),
      report,
    );
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
