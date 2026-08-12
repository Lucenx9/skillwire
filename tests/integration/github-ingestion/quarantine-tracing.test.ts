import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  GitHubSourceProvider,
  OperationContext,
} from "../../../src/application/ports/github-source-provider.js";
import { SourceRegistrationService } from "../../../src/application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../../../src/application/services/source-synchronization-service.js";
import type {
  GitHubRepositoryCoordinate,
  GitHubRepositoryIdentity,
  GitHubRepositorySnapshot,
  GitTreeEntry,
} from "../../../src/domain/external-catalog/types.js";
import { DEFAULT_INGESTION_BUDGETS } from "../../../src/domain/external-catalog/types.js";
import { PostgresExternalCatalogStore } from "../../../src/persistence/postgres/external-catalog-store.js";
import { PostgresSyncLeaseStore } from "../../../src/persistence/postgres/sync-lease-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

const LICENSE = `MIT License

Copyright 2026 Fixture Owner

Permission is hereby granted, free of charge, to any person obtaining a copy.
`;

class StaticRepositoryProvider implements GitHubSourceProvider {
  readonly #blobs = new Map<string, Uint8Array>();
  readonly #snapshot: GitHubRepositorySnapshot;

  constructor(
    readonly repository: GitHubRepositoryIdentity,
    commitSha: string,
    files: Readonly<Record<string, string>>,
  ) {
    const tree: GitTreeEntry[] = Object.entries(files).map(
      ([path, content]) => {
        const bytes = new TextEncoder().encode(content);
        const sha = createHash("sha1")
          .update(`blob ${String(bytes.byteLength)}\0`)
          .update(bytes)
          .digest("hex");
        this.#blobs.set(sha, bytes);
        return {
          path,
          mode: "100644",
          type: "blob",
          sha,
          size: bytes.byteLength,
        };
      },
    );
    this.#snapshot = {
      repository,
      commitSha,
      treeSha: createHash("sha1").update(JSON.stringify(tree)).digest("hex"),
      tree,
    };
  }

  resolvePublicRepository(
    _coordinate: GitHubRepositoryCoordinate,
    _context?: OperationContext,
  ): Promise<GitHubRepositoryIdentity> {
    return Promise.resolve(this.repository);
  }

  readDefaultSnapshot(): Promise<GitHubRepositorySnapshot> {
    return Promise.resolve(this.#snapshot);
  }

  readSnapshotAtCommit(
    _repository: GitHubRepositoryIdentity,
    commitSha: string,
  ): Promise<GitHubRepositorySnapshot> {
    if (commitSha !== this.#snapshot.commitSha)
      throw new Error("COMMIT_MISMATCH");
    return Promise.resolve(this.#snapshot);
  }

  readBlob(
    _repository: GitHubRepositoryIdentity,
    sha: string,
    expectedSize: number,
  ): Promise<Uint8Array> {
    const bytes = this.#blobs.get(sha);
    if (bytes?.byteLength !== expectedSize) throw new Error("HASH_MISMATCH");
    return Promise.resolve(bytes);
  }
}

function document(name: string, license?: string): string {
  return `---\nname: ${name}\ndescription: Fixture ${name}.\n${license === undefined ? "" : `license: ${license}\n`}---\nSafe instructions.\n`;
}

describe("traceable deterministic quarantine", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
  }, 120_000);

  afterAll(async () => database.close());

  it("records one stable synthetic result for a malformed manifest", async () => {
    const provider = new StaticRepositoryProvider(
      {
        repositoryId: 71_001,
        owner: "fixture-owner",
        repository: "malformed-manifest",
        defaultBranch: "main",
      },
      "7".repeat(40),
      { ".claude-plugin/plugin.json": "{ malformed" },
    );
    const store = new PostgresExternalCatalogStore(database.pool);
    const registration = await new SourceRegistrationService(
      provider,
      store,
    ).add(provider.repository, "fixture-admin");
    const sync = new SourceSynchronizationService(provider, store);
    const first = await sync.sync(registration.sourceId);
    expect(first.traces).toEqual([]);
    expect(first.candidateTraces).toEqual([
      expect.objectContaining({
        classification: "quarantined",
        reasonCodes: ["MANIFEST_INVALID"],
        result: "quarantined",
      }),
    ]);
    await expect(sync.sync(registration.sourceId)).resolves.toMatchObject({
      snapshotId: first.snapshotId,
      created: false,
      candidateTraces: first.candidateTraces,
    });
  });

  it("quarantines duplicate identities independently while publishing an eligible sibling", async () => {
    const provider = new StaticRepositoryProvider(
      {
        repositoryId: 71_002,
        owner: "fixture-owner",
        repository: "duplicate-identities",
        defaultBranch: "main",
      },
      "8".repeat(40),
      {
        LICENSE,
        "one/SKILL.md": document("duplicate"),
        "two/SKILL.md": document("duplicate"),
        "valid/SKILL.md": document("valid-sibling"),
      },
    );
    const store = new PostgresExternalCatalogStore(database.pool);
    const registration = await new SourceRegistrationService(
      provider,
      store,
    ).add(provider.repository, "fixture-admin");
    const result = await new SourceSynchronizationService(provider, store).sync(
      registration.sourceId,
    );
    expect(result.candidateTraces).toHaveLength(3);
    expect(
      result.candidateTraces.filter(
        ({ classification }) => classification === "quarantined",
      ),
    ).toEqual([
      expect.objectContaining({ reasonCodes: ["SKILL_DUPLICATE_IDENTITY"] }),
      expect.objectContaining({ reasonCodes: ["SKILL_DUPLICATE_IDENTITY"] }),
    ]);
    expect(result.traces).toEqual([
      expect.objectContaining({
        skillName: "valid-sibling",
        result: "published",
      }),
    ]);
  });

  it("rolls back publication when the lease expires immediately before commit", async () => {
    const provider = new StaticRepositoryProvider(
      {
        repositoryId: 71_003,
        owner: "fixture-owner",
        repository: "lease-expiry",
        defaultBranch: "main",
      },
      "9".repeat(40),
      { LICENSE, "valid/SKILL.md": document("lease-expiry") },
    );
    const store = new PostgresExternalCatalogStore(database.pool);
    const registration = await new SourceRegistrationService(
      provider,
      store,
    ).add(provider.repository, "fixture-admin");
    await database.pool.query(`
      CREATE FUNCTION delay_external_candidate() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.3);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER delay_external_candidate
      BEFORE INSERT ON external_import_candidates
      FOR EACH ROW EXECUTE FUNCTION delay_external_candidate();
    `);
    const lease = await new PostgresSyncLeaseStore(database.pool).acquire(
      `sync/${registration.sourceId}`,
      randomUUID(),
      200,
    );
    if (lease === undefined) throw new Error("fixture lease missing");
    await expect(
      new SourceSynchronizationService(provider, store).syncScheduled(
        registration.sourceId,
        lease,
      ),
    ).rejects.toThrow("LEASE_LOST");
    expect(
      (
        await database.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM external_source_snapshots WHERE source_id=$1",
          [registration.sourceId],
        )
      ).rows[0]?.count,
    ).toBe("0");
    await database.pool.query(`
      DROP TRIGGER delay_external_candidate ON external_import_candidates;
      DROP FUNCTION delay_external_candidate();
    `);
  });

  it("applies skill-over-repository license precedence and preserves NOTICE evidence", async () => {
    const notice = "Third-party notices for the fixture.\n";
    const specificNotice = "Specific notices for the Apache skill.\n";
    const apache = `Apache License\nVersion 2.0\n\nCopyright 2026 Fixture Owner\n`;
    const provider = new StaticRepositoryProvider(
      {
        repositoryId: 71_004,
        owner: "fixture-owner",
        repository: "legal-precedence",
        defaultBranch: "main",
      },
      "a".repeat(40),
      {
        LICENSE,
        NOTICE: notice,
        "specific/LICENSE": apache,
        "specific/NOTICE": specificNotice,
        "specific/SKILL.md": document("specific", "Apache-2.0"),
        "conflicting/SKILL.md": document("conflicting", "Apache-2.0"),
      },
    );
    const store = new PostgresExternalCatalogStore(database.pool);
    const registration = await new SourceRegistrationService(
      provider,
      store,
    ).add(provider.repository, "fixture-admin");
    const result = await new SourceSynchronizationService(provider, store).sync(
      registration.sourceId,
    );
    expect(result.traces).toEqual([
      expect.objectContaining({ skillName: "specific", result: "published" }),
    ]);
    expect(
      result.candidateTraces.find(
        ({ skillName }) => skillName === "conflicting",
      ),
    ).toMatchObject({
      classification: "quarantined",
      reasonCodes: ["LICENSE_CONFLICT"],
    });
    const legal = await database.pool.query<{
      spdx_license_id: string;
      license_evidence_path: string;
      license_blob_sha: string;
      skill_declared_spdx_id: string;
      notice_sha256: string;
      notice_evidence_path: string;
      notice_blob_sha: string;
      notice_text: string;
    }>(
      `SELECT r.spdx_license_id,r.license_evidence_path,r.license_blob_sha,
              r.skill_declared_spdx_id,r.notice_sha256,r.notice_evidence_path,
              r.notice_blob_sha,content.content AS notice_text
       FROM external_skill_revisions r
       JOIN external_content_objects content ON content.sha256=r.notice_sha256
       WHERE r.name='specific'`,
    );
    expect(legal.rows[0]).toEqual({
      spdx_license_id: "Apache-2.0",
      license_evidence_path: "specific/LICENSE",
      license_blob_sha: legal.rows[0]?.license_blob_sha,
      skill_declared_spdx_id: "Apache-2.0",
      notice_sha256: legal.rows[0]?.notice_sha256,
      notice_evidence_path: "specific/NOTICE",
      notice_blob_sha: legal.rows[0]?.notice_blob_sha,
      notice_text: specificNotice,
    });
    expect(legal.rows[0]?.license_blob_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(legal.rows[0]?.notice_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(legal.rows[0]?.notice_blob_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("turns configurable skill, resource, and aggregate byte budget failures into quarantine", async () => {
    const scenarios = [
      {
        repositoryId: 71_005,
        files: {
          LICENSE,
          "one/SKILL.md": document("one"),
          "two/SKILL.md": document("two"),
        },
        budgets: { maximumCandidates: 1 },
        reason: "TREE_OVERSIZED",
      },
      {
        repositoryId: 71_006,
        files: {
          LICENSE,
          "one/SKILL.md": `${document("one")}\n[a](a.md)\n[b](b.txt)\n`,
          "one/a.md": "a\n",
          "one/b.txt": "b\n",
        },
        budgets: { maximumResourcesPerSkill: 1 },
        reason: "RESOURCE_OVERSIZED",
      },
      {
        repositoryId: 71_007,
        files: { LICENSE, "one/SKILL.md": document("one") },
        budgets: { maximumRepositoryBytes: 16 },
        reason: "RESOURCE_OVERSIZED",
      },
    ] as const;
    for (const scenario of scenarios) {
      const repository = `budget-${String(scenario.repositoryId)}`;
      const provider = new StaticRepositoryProvider(
        {
          repositoryId: scenario.repositoryId,
          owner: "fixture-owner",
          repository,
          defaultBranch: "main",
        },
        createHash("sha1").update(repository).digest("hex"),
        scenario.files,
      );
      const store = new PostgresExternalCatalogStore(database.pool);
      const registration = await new SourceRegistrationService(
        provider,
        store,
      ).add(provider.repository, "fixture-admin");
      const result = await new SourceSynchronizationService(provider, store, {
        ...DEFAULT_INGESTION_BUDGETS,
        ...scenario.budgets,
      }).sync(registration.sourceId);
      expect(result.traces).toEqual([]);
      expect(result.candidateTraces).toEqual([
        expect.objectContaining({
          classification: "quarantined",
          reasonCodes: [scenario.reason],
        }),
      ]);
    }
  });
});
