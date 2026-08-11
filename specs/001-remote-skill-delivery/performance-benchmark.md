# Reproducible Informational Performance Measurement

## Purpose and Status

Performance measurement records engineering evidence for future target setting. It is not a product
requirement, acceptance criterion, release gate, or shared-runner timing check. The MVP has no fixed
latency or throughput threshold. Observed percentiles are report data only.

Normal CI validates the versioned workload and report schemas and may run a short functional smoke
mix with no elapsed-time assertion. Neither CI nor release readiness depends on executing the full
measurement or achieving a particular result.

## Reference Environment

The reference profile is:

- Linux x86-64;
- 4 dedicated vCPUs and 8 GiB RAM for the measurement stack;
- PostgreSQL on the same Docker host as SkillWire;
- the fixed ten-skill launch catalog;
- 25 concurrent authenticated MCP clients;
- 100 unmeasured warm-up operations;
- at least 1,000 measured operations per catalog-cache state; and
- no network traffic outside the local Compose network during measurement.

A run with different resources is valid evidence only when the differences are recorded. It must not
be presented as directly comparable without qualification.

## Measured Architecture

The measurement uses the production modular-monolith composition and one authoritative PostgreSQL
database. Repository-memory operations always reach PostgreSQL directly. There is no
repository-memory cache profile, hit ratio, warm-up state, bypass, or invalidation behavior to
measure.

The two cache states apply only to the verified immutable catalog cache:

- `catalog-cold`: use the benchmark-only composition override with catalog caching disabled, perform
  100 unmeasured operations to warm the process and database code paths, and verify the immutable
  catalog source on every measured operation; and
- `catalog-warm`: preload and verify the ten immutable revisions, run 100 warm-up operations, and
  then record the identical operation mix without clearing catalog entries.

The Compose benchmark override controls these profiles internally. No MCP operation exposes cache
inspection, clearing, or bypass.

## Versioned Inputs

The checked benchmark inputs are:

- `benchmarks/operation-mix.v1.json` — deterministic operation proportions and input fixture keys;
- `benchmarks/result.schema.json` — raw and aggregate report contract;
- `evaluation/search-ranking.v1.json` — frozen search corpus;
- `evaluation/three-call-journeys.v1.json` — frozen journey corpus;
- the exact published catalog release and advisory-chain head; and
- the deterministic PostgreSQL fixture revision used for repository-memory calls.

Initial dataset labels are `launch-catalog-v1`, `search-ranking-v1`,
`three-call-journeys-v1`, and `benchmark-fixture-v1`. Reports record immutable hashes or exact commit
identifiers in addition to friendly labels.

## Required Run Metadata

Every report records:

- operating system, kernel, architecture, CPU model and allocation, and memory limit;
- Docker and Compose versions and all container image digests;
- exact Node.js, pnpm, PostgreSQL, MCP SDK, Hono, Zod, and SkillWire versions;
- application commit and benchmark-runner revision;
- catalog release identifier, inventory hash, revision bundle hashes, and advisory-chain head;
- search, journey, operation-mix, and database-fixture revisions;
- client concurrency, warm-up count, measured sample count, and cache state;
- start/end timestamps and monotonic clock source; and
- whether service and database availability remained continuous for the run.

## Sampling and Results

Use a monotonic high-resolution clock around every complete MCP call. Each raw row contains:

```text
{ sequence, clientId, operation, catalogCacheState, startedOffsetNs, durationNs, resultCode }
```

The aggregate contains attempted, succeeded, and failed counts plus observed p50, p95, and p99 by
operation and catalog-cache state. It also contains every required metadata field and the SHA-256 of
the canonical raw rows. Failed operations remain in raw evidence and counts; they are never removed
to improve reported observations.

The runner validates output against `benchmarks/result.schema.json`. Local raw and aggregate reports
may be placed under ignored `benchmarks/results/` or attached to a manually triggered workflow. They
are not committed by default.

## Interpretation

- A report is complete or incomplete based on its schema and evidence, never fast or slow.
- Cold and warm immutable-catalog observations remain separate.
- Comparisons require matching dataset, workload, concurrency, cache state, and compatible hardware
  and software metadata; otherwise differences are explicitly qualified.
- No percentile, throughput, or failure-count observation changes MVP acceptance or release status.
- Functional failures discovered by a measurement are handled through the relevant contract,
  integration, end-to-end, or security test—not through a timing gate.
- Establishing a future target requires a later specification change informed by recorded evidence.

## Execution

```bash
docker compose -f compose.yaml -f compose.benchmark.yaml up --build --wait
pnpm benchmark:informational
```

The command writes only benchmark result artifacts in the designated local result directory. It does
not mutate catalog publications, repository memory fixtures, advisory records, or application
acceptance state.
