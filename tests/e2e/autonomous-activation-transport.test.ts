import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  loadSkillOutputSchema,
  readSkillResourceOutputSchema,
  searchSkillsOutputSchema,
} from "../../src/transport/mcp/schemas.js";
import {
  attemptActivationMcpConnection,
  createActivationMcpHarness,
  type ActivationMcpHarness,
} from "../helpers/activation-mcp-harness.js";
import { importedCatalogFixture } from "../helpers/imported-catalog-provider.js";
import { FakeRepositoryMemoryStore } from "../helpers/memory-store.js";
import {
  loadActivationFixtures,
  validateActivationFixtures,
} from "../../src/evaluation/activation-corpus-runner.js";
import { createSkillRevision } from "../../src/domain/catalog/canonical-revision.js";
import type { AsyncSkillCatalogProvider } from "../../src/application/ports/async-skill-catalog-provider.js";
import type {
  CatalogSkillMetadata,
  SkillRevision,
} from "../../src/domain/catalog/types.js";
import { validateCodexAdapterPackage } from "../../src/evaluation/codex-adapter-package.js";

describe("autonomous activation through the registered MCP transport", () => {
  const harnesses: ActivationMcpHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  });

  it("records a real preview to exact load journey without an unnecessary resource call", async () => {
    const harness = await createActivationMcpHarness({ protocol: "modern" });
    harnesses.push(harness);

    const search = searchSkillsOutputSchema.parse(
      (
        await harness.callTool("search_skills", {
          task: "Review strict TypeScript narrowing and type safety",
          invocationContext: "automatic",
          limit: 1,
        })
      ).structuredContent,
    );
    const preview = search.skills[0];
    expect(preview).toMatchObject({
      skillId: "typescript-code-review",
      revision: "1.0.0",
      currentAdvisoryStatus: "available",
      trustAtPublication: "trusted",
    });

    const loaded = loadSkillOutputSchema.parse(
      (
        await harness.callTool("load_skill", {
          skillId: preview?.skillId,
          revision: preview?.revision,
        })
      ).structuredContent,
    );

    expect(loaded).toMatchObject({
      skillId: "typescript-code-review",
      revision: "1.0.0",
      revisionSha256:
        "23ae106db34f706318436b69b6bf2380ce828bf6d2f685a629e946f6ad6827ec",
      currentAdvisoryStatus: "available",
      memoryRecorded: false,
      publishedProvenance: {
        trustAtPublication: "trusted",
      },
    });
    expect(harness.toolCalls.map(({ name }) => name)).toEqual([
      "search_skills",
      "load_skill",
    ]);
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });

  it("records one useful declared resource after the verified exact load", async () => {
    const harness = await createActivationMcpHarness({ protocol: "legacy" });
    harnesses.push(harness);

    const search = searchSkillsOutputSchema.parse(
      (
        await harness.callTool("search_skills", {
          task: "Plan a dependency upgrade with compatibility and rollback",
          invocationContext: "automatic",
          limit: 1,
        })
      ).structuredContent,
    );
    const preview = search.skills[0];
    const loaded = loadSkillOutputSchema.parse(
      (
        await harness.callTool("load_skill", {
          skillId: preview?.skillId,
          revision: preview?.revision,
        })
      ).structuredContent,
    );
    const declared = loaded.resourceManifest.find(
      ({ path }) => path === "references/upgrade-checklist.md",
    );
    expect(declared).toBeDefined();

    const resource = readSkillResourceOutputSchema.parse(
      (
        await harness.callTool("read_skill_resource", {
          skillId: loaded.skillId,
          revision: loaded.revision,
          path: declared?.path,
        })
      ).structuredContent,
    );

    expect(resource).toMatchObject({
      skillId: loaded.skillId,
      revision: loaded.revision,
      revisionSha256: loaded.revisionSha256,
      path: declared?.path,
      sha256: declared?.sha256,
    });
    expect(harness.toolCalls.map(({ name }) => name)).toEqual([
      "search_skills",
      "load_skill",
      "read_skill_resource",
    ]);
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });

  it("stops after one automatic search returns no relevant preview", async () => {
    const harness = await createActivationMcpHarness({ protocol: "modern" });
    harnesses.push(harness);

    const search = searchSkillsOutputSchema.parse(
      (
        await harness.callTool("search_skills", {
          task: "quasar xylophone zephyr",
          invocationContext: "automatic",
          limit: 10,
        })
      ).structuredContent,
    );

    expect(search.skills).toEqual([]);
    expect(harness.toolCalls.map(({ name }) => name)).toEqual([
      "search_skills",
    ]);
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });

  it("does not escalate automatic context or load a user-only skill without intent", async () => {
    const harness = await createActivationMcpHarness({
      protocol: "modern",
      application: { importedCatalogProvider: importedCatalogFixture.provider },
    });
    harnesses.push(harness);

    const search = searchSkillsOutputSchema.parse(
      (
        await harness.callTool("search_skills", {
          task: "Decide which engineering workflow fits a multi-session feature.",
          invocationContext: "automatic",
          limit: 10,
        })
      ).structuredContent,
    );

    expect(
      search.skills.some(
        ({ skillId }) => skillId === importedCatalogFixture.userOnlyId,
      ),
    ).toBe(false);
    expect(harness.toolCalls).toMatchObject([
      {
        name: "search_skills",
        arguments: { invocationContext: "automatic" },
      },
    ]);
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });

  it("uses user-requested context only for an explicit user-only skill request", async () => {
    const harness = await createActivationMcpHarness({
      protocol: "modern",
      application: { importedCatalogProvider: importedCatalogFixture.provider },
    });
    harnesses.push(harness);

    const search = searchSkillsOutputSchema.parse(
      (
        await harness.callTool("search_skills", {
          task: "Use the ask-matt skill to choose an engineering workflow.",
          invocationContext: "user-requested",
          limit: 1,
        })
      ).structuredContent,
    );
    const preview = search.skills[0];
    expect(preview).toMatchObject({
      skillId: importedCatalogFixture.userOnlyId,
      revision: importedCatalogFixture.revision,
      invocationMode: "user-only",
    });

    const loaded = loadSkillOutputSchema.parse(
      (
        await harness.callTool("load_skill", {
          skillId: preview?.skillId,
          revision: preview?.revision,
        })
      ).structuredContent,
    );
    expect(loaded).toMatchObject({
      skillId: importedCatalogFixture.userOnlyId,
      revision: importedCatalogFixture.revision,
      revisionSha256: "a".repeat(64),
      invocationMode: "user-only",
      currentClassification: "verified",
    });
    expect(harness.toolCalls.map(({ name }) => name)).toEqual([
      "search_skills",
      "load_skill",
    ]);
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });

  it("records memory only for the exact provenance-bearing MCP load", async () => {
    const memoryStore = new FakeRepositoryMemoryStore();
    const harness = await createActivationMcpHarness({
      protocol: "modern",
      application: { memoryStore },
    });
    harnesses.push(harness);
    const repositoryHash = "e".repeat(64);

    const search = searchSkillsOutputSchema.parse(
      (
        await harness.callTool("search_skills", {
          task: "Review TypeScript type safety",
          invocationContext: "automatic",
          repositoryHash,
          limit: 1,
        })
      ).structuredContent,
    );
    expect(memoryStore.recordUsageCount).toBe(0);
    const preview = search.skills[0];
    const loaded = loadSkillOutputSchema.parse(
      (
        await harness.callTool("load_skill", {
          skillId: preview?.skillId,
          revision: preview?.revision,
          repositoryHash,
        })
      ).structuredContent,
    );

    expect(loaded.memoryRecorded).toBe(true);
    expect(memoryStore.recordUsageCount).toBe(1);
    expect(memoryStore.recordUsageCalls[0]).toMatchObject({
      scope: { repositoryHash },
      input: {
        skillId: loaded.skillId,
        revision: loaded.revision,
        revisionSha256: loaded.revisionSha256,
      },
    });
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });

  it("does not mistake predeclared local guidance for a SkillWire load", async () => {
    const memoryStore = new FakeRepositoryMemoryStore();
    const harness = await createActivationMcpHarness({
      protocol: "legacy",
      application: { memoryStore },
    });
    harnesses.push(harness);
    const { corpus } = validateActivationFixtures(
      loadActivationFixtures(process.cwd()),
    );
    const local = corpus.cases.find(({ id }) => id === "auto-overlap-1");

    expect(local?.localSkillFixture).toMatchObject({
      fixtureId: "local-typescript-review",
      relationship: "equivalent",
      explicitlySelected: true,
    });
    expect(local?.expectedBehavior.operationSequence).toEqual([]);
    expect(harness.toolCalls).toEqual([]);
    expect(memoryStore.recordUsageCount).toBe(0);
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });

  it("attributes neither adapter inventory, local guidance, previews, nor failed loads as remote usage", async () => {
    const memoryStore = new FakeRepositoryMemoryStore();
    const adapter = validateCodexAdapterPackage(
      join(process.cwd(), "integrations/codex/skillwire-autonomous-activation"),
    );
    const { corpus } = validateActivationFixtures(
      loadActivationFixtures(process.cwd()),
    );
    const local = corpus.cases.find(
      ({ localSkillFixture }) => localSkillFixture !== undefined,
    );
    expect(adapter.pluginName).toBe("skillwire-autonomous-activation");
    expect(local?.expectedBehavior.operationSequence).toEqual([]);
    expect(memoryStore.recordUsageCount).toBe(0);

    const attempted = await createActivationMcpHarness({
      protocol: "modern",
      application: { memoryStore },
    });
    harnesses.push(attempted);
    const preview = searchSkillsOutputSchema.parse(
      (
        await attempted.callTool("search_skills", {
          task: "Review TypeScript type safety",
          invocationContext: "automatic",
          repositoryHash: "7".repeat(64),
          limit: 1,
        })
      ).structuredContent,
    ).skills[0];
    expect(preview).toBeDefined();
    expect(memoryStore.recordUsageCount).toBe(0);
    const failed = await attempted.callTool("load_skill", {
      skillId: "missing-skill",
      revision: "1.0.0",
      repositoryHash: "7".repeat(64),
    });
    expect(failed.isError).toBe(true);
    expect(memoryStore.recordUsageCount).toBe(0);

    const verified = await createActivationMcpHarness({
      protocol: "modern",
      application: { memoryStore },
    });
    harnesses.push(verified);
    const exactPreview = searchSkillsOutputSchema.parse(
      (
        await verified.callTool("search_skills", {
          task: "Review TypeScript type safety",
          invocationContext: "automatic",
          repositoryHash: "7".repeat(64),
          limit: 1,
        })
      ).structuredContent,
    ).skills[0];
    const exact = loadSkillOutputSchema.parse(
      (
        await verified.callTool("load_skill", {
          skillId: exactPreview?.skillId,
          revision: exactPreview?.revision,
          repositoryHash: "7".repeat(64),
        })
      ).structuredContent,
    );
    expect(exact).toMatchObject({
      skillId: exactPreview?.skillId,
      revision: exactPreview?.revision,
      memoryRecorded: true,
    });
    expect(memoryStore.recordUsageCount).toBe(1);
    await expect(attempted.clientTreeIsUnchanged()).resolves.toBe(true);
    await expect(verified.clientTreeIsUnchanged()).resolves.toBe(true);
  });

  it.each([
    {
      name: "unavailable service",
      options: { serviceUnavailable: true },
      status: 503,
    },
    {
      name: "authentication failure",
      options: { bearerToken: "invalid-token" },
      status: 401,
    },
  ])(
    "fails open during $name without a tool retry",
    async ({ options, status }) => {
      const attempt = await attemptActivationMcpConnection({
        protocol: "modern",
        ...options,
      });

      expect(attempt.connected).toBe(false);
      expect(attempt.protocolMethods).toEqual(["server/discover"]);
      expect(attempt.httpStatuses).toEqual([status]);
      expect(attempt.toolCalls).toEqual([]);
      expect(attempt.clientTreeUnchanged).toBe(true);
    },
  );

  it("stops after the one automatic search is rate limited", async () => {
    const harness = await createActivationMcpHarness({
      protocol: "legacy",
      application: {
        rateLimit: {
          accountRequestsPerMinute: 1,
          apiKeyRequestsPerMinute: 1,
          burst: 2,
        },
      },
    });
    harnesses.push(harness);

    await expect(
      harness.callTool("search_skills", {
        task: "TypeScript code review",
        invocationContext: "automatic",
      }),
    ).rejects.toThrow();
    expect(harness.toolCalls.map(({ name }) => name)).toEqual([
      "search_skills",
    ]);
    expect(harness.httpStatuses.at(-1)).toBe(429);
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });

  it.each([
    { name: "exact revision unavailable", mode: "unavailable" as const },
    { name: "request timeout", mode: "timeout" as const },
  ])("does not retry or substitute after $name", async ({ mode }) => {
    const provider = transientProvider(mode);
    const harness = await createActivationMcpHarness({
      protocol: "modern",
      application: {
        importedCatalogProvider: provider,
        ...(mode === "timeout" ? { requestDeadlineMilliseconds: 5 } : {}),
      },
    });
    harnesses.push(harness);
    const search = searchSkillsOutputSchema.parse(
      (
        await harness.callTool("search_skills", {
          task: "Transient specialized skill",
          invocationContext: "automatic",
          limit: 1,
        })
      ).structuredContent,
    );
    const preview = search.skills[0];

    if (mode === "timeout") {
      await expect(
        harness.callTool("load_skill", {
          skillId: preview?.skillId,
          revision: preview?.revision,
        }),
      ).rejects.toThrow();
    } else {
      const loaded = await harness.callTool("load_skill", {
        skillId: preview?.skillId,
        revision: preview?.revision,
      });
      expect(loaded.isError).toBe(true);
    }
    expect(harness.toolCalls.map(({ name }) => name)).toEqual([
      "search_skills",
      "load_skill",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });

  it("stops on repository-memory failure without recording usage", async () => {
    const memoryStore = new FakeRepositoryMemoryStore();
    memoryStore.failNextRecordUsage();
    const harness = await createActivationMcpHarness({
      protocol: "legacy",
      application: { memoryStore },
    });
    harnesses.push(harness);
    const search = searchSkillsOutputSchema.parse(
      (
        await harness.callTool("search_skills", {
          task: "TypeScript code review",
          invocationContext: "automatic",
          limit: 1,
        })
      ).structuredContent,
    );
    const preview = search.skills[0];
    const loaded = await harness.callTool("load_skill", {
      skillId: preview?.skillId,
      revision: preview?.revision,
      repositoryHash: "f".repeat(64),
    });

    expect(loaded.isError).toBe(true);
    expect(memoryStore.recordUsageCount).toBe(0);
    expect(harness.toolCalls.map(({ name }) => name)).toEqual([
      "search_skills",
      "load_skill",
    ]);
  });

  it("retains verified-load memory but does not retry a failed resource", async () => {
    const memoryStore = new FakeRepositoryMemoryStore();
    const harness = await createActivationMcpHarness({
      protocol: "modern",
      application: {
        memoryStore,
        importedCatalogProvider: transientProvider("resource-failure"),
      },
    });
    harnesses.push(harness);
    const repositoryHash = "1".repeat(64);
    const search = searchSkillsOutputSchema.parse(
      (
        await harness.callTool("search_skills", {
          task: "Transient specialized skill",
          invocationContext: "automatic",
          limit: 1,
        })
      ).structuredContent,
    );
    const preview = search.skills[0];
    const loaded = loadSkillOutputSchema.parse(
      (
        await harness.callTool("load_skill", {
          skillId: preview?.skillId,
          revision: preview?.revision,
          repositoryHash,
        })
      ).structuredContent,
    );
    const resource = await harness.callTool("read_skill_resource", {
      skillId: loaded.skillId,
      revision: loaded.revision,
      path: loaded.resourceManifest[0]?.path,
    });

    expect(resource.isError).toBe(true);
    expect(memoryStore.recordUsageCount).toBe(1);
    expect(harness.toolCalls.map(({ name }) => name)).toEqual([
      "search_skills",
      "load_skill",
      "read_skill_resource",
    ]);
    expect(harness.githubRequestCount).toBe(0);
    await expect(harness.clientTreeIsUnchanged()).resolves.toBe(true);
  });
});

function transientProvider(
  mode: "unavailable" | "timeout" | "resource-failure",
): AsyncSkillCatalogProvider {
  const skillId = "transient-skill";
  const revision = createSkillRevision({
    skillId,
    revision: "1.0.0",
    publishedProvenance: {
      source: { provider: "fixture", reference: "fixture:transient-skill" },
      sourceRevision: "1.0.0",
      owner: "SkillWire tests",
      license: "Apache-2.0",
      trustAtPublication: "trusted",
    },
    instructions: "# Transient Skill\n\nUse inert fixture guidance.\n",
    resources: [
      {
        path: "references/fixture.md",
        mediaType: "text/markdown",
        content: "# Fixture\n\nVerified resource.\n",
      },
    ],
  });
  const metadata: CatalogSkillMetadata = {
    id: skillId,
    name: "Transient Skill",
    description: "Transient specialized skill fixture",
    capabilities: ["transient specialized skill"],
    revision: revision.revision,
    trustAtPublication: "trusted",
    currentAdvisoryStatus: "available",
  };
  let findCount = 0;
  return {
    listMetadata: () => Promise.resolve([metadata]),
    advisoryStatus: () => Promise.resolve("available"),
    findRevision: async () => {
      findCount += 1;
      if (mode === "unavailable") throw new Error("fixture unavailable");
      if (mode === "timeout") {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (mode === "resource-failure" && findCount > 1) {
        const corrupt: SkillRevision = {
          ...revision,
          resources: revision.resources.map((resource) => ({
            ...resource,
            content: `${resource.content}corrupt`,
          })),
        };
        return corrupt;
      }
      return revision;
    },
  };
}
