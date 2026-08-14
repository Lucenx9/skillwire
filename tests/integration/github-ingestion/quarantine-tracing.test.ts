import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  GitHubSourceProvider,
  OperationContext,
} from "../../../src/application/ports/github-source-provider.js";
import { SourceRegistrationService } from "../../../src/application/services/source-registration-service.js";
import { SourceSynchronizationService } from "../../../src/application/services/source-synchronization-service.js";
import {
  canonicalJson,
  sha256Hex,
} from "../../../src/domain/catalog/canonical-revision.js";
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

function documentWithInstructions(name: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: Fixture ${name}.\n---\n${instructions}\n`;
}

describe("traceable deterministic quarantine", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
  }, 120_000);

  afterAll(async () => database.close());

  it("keeps distinct append-only generations when stable findings change", async () => {
    const provider = new StaticRepositoryProvider(
      {
        repositoryId: 70_999,
        owner: "fixture-owner",
        repository: "validation-generations",
        defaultBranch: "main",
      },
      "5".repeat(40),
      { LICENSE },
    );
    const store = new PostgresExternalCatalogStore(database.pool);
    const registration = await new SourceRegistrationService(
      provider,
      store,
    ).add(provider.repository, "fixture-admin");
    const candidate = {
      skillPath: "_invalid/generation/SKILL.md",
      name: "invalid-generation",
      description: "A deterministic validation failure.",
      adapterKind: "claude-plugin" as const,
      classification: "quarantined" as const,
    };
    const base = {
      sourceId: registration.sourceId,
      commitSha: "5".repeat(40),
      treeSha: "6".repeat(40),
      manifestVersion: "invalid-v1",
      adapterKind: "claude-plugin" as const,
      revisions: [],
      observedRepository: registration.repository,
    };
    const initialCandidates = [
      {
        ...candidate,
        findings: [
          {
            code: "MANIFEST_INVALID" as const,
            severity: "error" as const,
            subjectKind: "snapshot" as const,
            subjectId: "manifest",
          },
        ],
      },
    ];
    const first = await store.publishSnapshot({
      ...base,
      candidates: initialCandidates,
      validationInputSha256: sha256Hex(
        canonicalJson({
          sourceId: registration.sourceId,
          commitSha: base.commitSha,
          treeSha: base.treeSha,
          candidates: [
            {
              skillPath: candidate.skillPath,
              name: candidate.name,
              classification: candidate.classification,
              contentIdentitySha256: null,
            },
          ],
        }),
      ),
    });
    await expect(
      store.publishSnapshot({ ...base, candidates: initialCandidates }),
    ).resolves.toMatchObject({
      created: false,
      snapshotId: first.snapshotId,
    });
    const correctedInput = {
      ...base,
      candidates: [
        {
          ...candidate,
          findings: [
            {
              code: "PATH_UNSAFE" as const,
              severity: "error" as const,
              subjectKind: "candidate" as const,
              subjectId: "skills/../escape",
            },
          ],
        },
      ],
    };
    const corrected = await store.publishSnapshot(correctedInput);

    expect(first.created).toBe(true);
    expect(corrected).toMatchObject({
      created: true,
      candidateTraces: [
        {
          classification: "quarantined",
          reasonCodes: ["PATH_UNSAFE"],
        },
      ],
    });
    expect(corrected.snapshotId).not.toBe(first.snapshotId);
    await expect(store.publishSnapshot(correctedInput)).resolves.toMatchObject({
      created: false,
      snapshotId: corrected.snapshotId,
    });
  });

  it("falls back to independent nested skills for plugin-only metadata", async () => {
    const provider = new StaticRepositoryProvider(
      {
        repositoryId: 71_000,
        owner: "fixture-owner",
        repository: "plugin-metadata-with-nested-skills",
        defaultBranch: "main",
      },
      "6".repeat(40),
      {
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "metadata-only",
          version: "1.0.0",
          description: "Plugin metadata without an inventory.",
          author: { name: "Fixture Owner", email: "owner@example.test" },
          license: "MIT",
          hooks: "./hooks/hooks.json",
        }),
        LICENSE,
        "hooks/hooks.json": "{}\n",
        "commands/install.md": "Do not ingest this command.\n",
        "skills/alpha/SKILL.md": documentWithInstructions(
          "alpha",
          "Use the [local guide](guide.md).",
        ),
        "skills/alpha/guide.md": "Alpha-local guidance.\n",
        "skills/beta/SKILL.md": document("beta"),
        "skills/beta/guide.md": "Unreferenced sibling guidance.\n",
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

    expect(result.traces.map(({ skillName }) => skillName)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(
      result.candidateTraces.map(({ classification }) => classification),
    ).toEqual(["verified", "verified"]);
    await expect(
      database.pool.query<{ adapter_kind: string }>(
        "SELECT adapter_kind FROM external_source_snapshots WHERE source_id=$1",
        [registration.sourceId],
      ),
    ).resolves.toMatchObject({ rows: [{ adapter_kind: "nested-skill" }] });
    await expect(
      database.pool.query<{
        name: string;
        resource_path: string;
        content: string;
      }>(
        `SELECT r.name,rr.resource_path,c.content
         FROM external_revision_resources rr
         JOIN external_skill_revisions r ON r.id=rr.revision_id
         JOIN external_content_objects c ON c.sha256=rr.content_sha256
         JOIN external_skill_identities i ON i.id=r.skill_identity_id
         WHERE i.source_id=$1`,
        [registration.sourceId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          name: "alpha",
          resource_path: "guide.md",
          content: "Alpha-local guidance.\n",
        },
      ],
    });
  });

  it("keeps an explicitly declared plugin inventory authoritative", async () => {
    const provider = new StaticRepositoryProvider(
      {
        repositoryId: 71_100,
        owner: "fixture-owner",
        repository: "authoritative-plugin",
        defaultBranch: "main",
      },
      "a".repeat(40),
      {
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "authoritative-plugin",
          version: "1.0.0",
          description: "Plugin with an explicit inventory.",
          author: { name: "Fixture Owner" },
          license: "MIT",
          skills: ["./skills/declared"],
        }),
        LICENSE,
        "skills/declared/SKILL.md": document("declared"),
        "skills/unlisted/SKILL.md": document("unlisted"),
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

    expect(result.traces.map(({ skillName }) => skillName)).toEqual([
      "declared",
    ]);
    await expect(
      database.pool.query<{ adapter_kind: string }>(
        "SELECT adapter_kind FROM external_source_snapshots WHERE source_id=$1",
        [registration.sourceId],
      ),
    ).resolves.toMatchObject({ rows: [{ adapter_kind: "claude-plugin" }] });
  });

  it("quarantines a hostile declared inventory without nested fallback", async () => {
    const provider = new StaticRepositoryProvider(
      {
        repositoryId: 71_101,
        owner: "fixture-owner",
        repository: "hostile-authoritative-plugin",
        defaultBranch: "main",
      },
      "b".repeat(40),
      {
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "hostile-authoritative-plugin",
          version: "1.0.0",
          description: "Plugin with an unsafe explicit inventory.",
          author: { name: "Fixture Owner" },
          license: "MIT",
          skills: ["./../outside"],
        }),
        LICENSE,
        "skills/safe/SKILL.md": document("must-not-fallback"),
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

    expect(result.traces).toEqual([]);
    expect(result.candidateTraces).toEqual([
      expect.objectContaining({
        classification: "quarantined",
        reasonCodes: ["PATH_UNSAFE"],
      }),
    ]);
  });

  it("records one stable synthetic result for a malformed manifest", async () => {
    const provider = new StaticRepositoryProvider(
      {
        repositoryId: 71_001,
        owner: "fixture-owner",
        repository: "malformed-manifest",
        defaultBranch: "main",
      },
      "7".repeat(40),
      {
        ".claude-plugin/plugin.json": "{ malformed",
        LICENSE,
        "skills/safe/SKILL.md": document("must-not-fallback"),
      },
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
