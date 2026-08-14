import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validateBenchmarkInputs } from "../../../benchmarks/informational-benchmark.js";
import { loadVerifiedCatalogProvider } from "../../../src/catalog/version-controlled-provider.js";
import {
  parseAdvisoryChain,
  verifyAdvisoryChain,
} from "../../../src/domain/catalog/advisory-chain.js";
import { assertRevisionIntegrity } from "../../../src/domain/catalog/revision-integrity.js";
import type { SkillRevision } from "../../../src/domain/catalog/types.js";
import {
  loadSearchEvaluationCorpus,
  validateSearchEvaluationCorpus,
} from "../../../src/evaluation/search-ranking-runner.js";
import {
  loadJourneyEvaluationMatrix,
  validateJourneyEvaluationMatrix,
} from "../../../src/evaluation/three-call-journey-runner.js";
import { githubFixture } from "../../helpers/github-api-stub.js";
import {
  createGitHubIngestionFixture,
  createSuperpowersIngestionFixture,
} from "../../helpers/github-ingestion-fixture.js";

const projectRoot = process.cwd();
const provider = loadVerifiedCatalogProvider(projectRoot, "launch-catalog-v1");

describe("immutable evaluation fixtures", () => {
  it("pins the Superpowers fixture while preserving the Matt Pocock recording byte-for-byte", async () => {
    const digest = (path: string) =>
      createHash("sha256").update(readFileSync(path)).digest("hex");
    const mattRoot = join(
      projectRoot,
      "tests/fixtures/github-ingestion/mattpocock-skills-84fdeffd12f2ee307994d1eb6feb48173b6e0502",
    );
    expect(digest(join(mattRoot, "expected-inventory.json"))).toBe(
      "bf13aa9aae40c020a6ce788e8b7cbe1d7288bc068a5872e71dfc5acbd9713cf5",
    );
    expect(digest(join(mattRoot, "routes.json"))).toBe(
      "6a21028ebc03ca5ddf205fe47463a968f31605d4c85a5971647abc0782e87034",
    );
    expect(digest(join(mattRoot, "responses/recording.json.gz.b64"))).toBe(
      "f78adc8dde1023d24148dec07dd962e6897ae5b175674f57aba736040df2963b",
    );

    const matt = await createGitHubIngestionFixture();
    expect(matt.inventory.skills).toHaveLength(25);
    const superpowers = await createSuperpowersIngestionFixture();
    expect(superpowers.inventory).toMatchObject({
      owner: "obra",
      repository: "superpowers",
      commitSha: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797",
      treeSha: "21219529a4e224bcb27baf8816b039c8bf7c6673",
      manifestVersion: "nested-v1",
      license: "MIT",
    });
    expect(superpowers.inventory.skills).toHaveLength(14);
  });

  it("contains at least thirty unique search cases and three per launch skill", () => {
    const corpus = loadSearchEvaluationCorpus(projectRoot);
    const validated = validateSearchEvaluationCorpus(
      corpus,
      provider.listMetadata(),
    );

    expect(validated.cases).toHaveLength(30);
    expect(new Set(validated.cases.map((entry) => entry.id)).size).toBe(30);
  });

  it("contains at least twenty unique journeys bound to declared resources", () => {
    const matrix = loadJourneyEvaluationMatrix(projectRoot);
    const validated = validateJourneyEvaluationMatrix(matrix, provider);

    expect(validated.cases).toHaveLength(20);
    expect(new Set(validated.cases.map((entry) => entry.id)).size).toBe(20);
  });

  it("validates the informational workload and result-schema inputs", () => {
    expect(() => {
      validateBenchmarkInputs(projectRoot);
    }).not.toThrow();
  });

  it("keeps canonical, corrupt, advisory, GitHub, auth, memory, and time fixtures independently usable", () => {
    const fixture = (...segments: string[]) =>
      join(projectRoot, "tests", "fixtures", ...segments);
    const canonical = JSON.parse(
      readFileSync(fixture("catalog", "canonical-revision.json"), "utf8"),
    ) as SkillRevision;
    const corrupt = JSON.parse(
      readFileSync(fixture("catalog", "corrupt-revision.json"), "utf8"),
    ) as SkillRevision;
    expect(() => assertRevisionIntegrity(canonical)).not.toThrow();
    expect(() => assertRevisionIntegrity(corrupt)).toThrow();

    const hashes = new Map([
      [
        "dependency-upgrade-planning\0" + "1.0.0",
        "b93eb2b23120b134df66b2adda7a7f94f12743ac6678369bf61561d923e4f599",
      ],
      [
        "dockerfile-hardening\0" + "1.0.0",
        "9a3f4ae15465afb34e89e7035316dc4b36bdbe4bcb9a3900a48dafcc37281f0d",
      ],
    ]);
    const valid = readFileSync(
      fixture("advisory-chain", "non-genesis-valid.jsonl"),
      "utf8",
    );
    expect(
      verifyAdvisoryChain(parseAdvisoryChain(valid), hashes).events,
    ).toHaveLength(2);
    for (const name of [
      "mutated.jsonl",
      "deleted.jsonl",
      "inserted.jsonl",
      "reordered.jsonl",
    ]) {
      const invalid = readFileSync(fixture("advisory-chain", name), "utf8");
      expect(() =>
        verifyAdvisoryChain(parseAdvisoryChain(invalid), hashes),
      ).toThrow();
    }

    expect(
      githubFixture(projectRoot, "published-releases.json"),
    ).toBeInstanceOf(Array);
    expect(githubFixture(projectRoot, "no-published-releases.json")).toEqual(
      [],
    );
    for (const path of [
      fixture("auth", "api-keys.json"),
      fixture("memory", "scopes.json"),
      fixture("time", "audit-expiration.json"),
      fixture("catalog", "multi-resource-revision", "expected-revision.json"),
    ]) {
      expect(JSON.parse(readFileSync(path, "utf8"))).toBeTypeOf("object");
    }
  });
});
