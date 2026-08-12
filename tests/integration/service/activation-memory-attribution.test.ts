import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLoadSkill } from "../../../src/application/use-cases/load-skill.js";
import { createReadSkillResource } from "../../../src/application/use-cases/read-skill-resource.js";
import { createRecordSkillOutcome } from "../../../src/application/use-cases/record-skill-outcome.js";
import { createSearchSkills } from "../../../src/application/use-cases/search-skills.js";
import { loadVerifiedCatalogProvider } from "../../../src/catalog/version-controlled-provider.js";
import {
  repositoryMemoryScope,
  type RequestPrincipal,
} from "../../../src/domain/repository-memory/types.js";
import { validateCodexAdapterPackage } from "../../../src/evaluation/codex-adapter-package.js";
import { PostgresApiKeyStore } from "../../../src/persistence/postgres/api-key-store.js";
import { PostgresRepositoryMemoryStore } from "../../../src/persistence/postgres/repository-memory-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

const pepper = "activation-memory-pepper-at-least-thirty-two-bytes";

describe("verified SkillWire load repository-memory attribution", () => {
  let database: TestDatabase;
  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
    accountA = randomUUID();
    accountB = randomUUID();
    const accounts = new PostgresApiKeyStore(database.pool, pepper);
    await accounts.createAccount(accountA);
    await accounts.createAccount(accountB);
  }, 120_000);

  afterAll(async () => database.close());

  it("attributes only a verified exact load and preserves its row through resource handling", async () => {
    const store = new PostgresRepositoryMemoryStore(database.pool);
    const provider = loadVerifiedCatalogProvider(
      process.cwd(),
      "launch-catalog-v1",
    );
    const hash = "d".repeat(64);
    const principalA: RequestPrincipal = {
      accountId: accountA,
      apiKeyId: randomUUID(),
      requestId: randomUUID(),
    };
    const principalB: RequestPrincipal = {
      accountId: accountB,
      apiKeyId: randomUUID(),
      requestId: randomUUID(),
    };
    const search = createSearchSkills(provider, store);
    const load = createLoadSkill(provider, store);
    const read = createReadSkillResource(provider);
    const outcome = createRecordSkillOutcome(store);
    const adapter = validateCodexAdapterPackage(
      join(process.cwd(), "integrations/codex/skillwire-autonomous-activation"),
    );
    expect(adapter.pluginName).toBe("skillwire-autonomous-activation");
    await expect(
      store.list(repositoryMemoryScope(accountA, hash)),
    ).resolves.toEqual([]);

    await search.execute(
      {
        task: "TypeScript code review",
        invocationContext: "automatic",
        repositoryHash: hash,
      },
      principalA,
    );
    await expect(
      store.list(repositoryMemoryScope(accountA, hash)),
    ).resolves.toEqual([]);

    await expect(
      load.execute(
        {
          skillId: "missing-skill",
          revision: "1.0.0",
          repositoryHash: hash,
        },
        principalA,
      ),
    ).rejects.toThrow();
    await expect(
      store.list(repositoryMemoryScope(accountA, hash)),
    ).resolves.toEqual([]);

    const loaded = await load.execute(
      {
        skillId: "typescript-code-review",
        revision: "1.0.0",
        repositoryHash: hash,
      },
      principalA,
    );
    await expect(
      store.list(repositoryMemoryScope(accountA, hash)),
    ).resolves.toMatchObject([
      {
        skillId: loaded.skillId,
        revision: loaded.revision,
        revisionSha256: loaded.revisionSha256,
        usageCount: 1,
      },
    ]);
    await expect(
      store.list(repositoryMemoryScope(principalB.accountId, hash)),
    ).resolves.toEqual([]);

    await read.execute({
      skillId: loaded.skillId,
      revision: loaded.revision,
      path: "references/review-checklist.md",
    });
    await expect(
      read.execute({
        skillId: loaded.skillId,
        revision: loaded.revision,
        path: "references/not-declared.md",
      }),
    ).rejects.toThrow();
    await expect(
      store.list(repositoryMemoryScope(accountA, hash)),
    ).resolves.toMatchObject([{ usageCount: 1 }]);

    await expect(
      outcome.execute(
        {
          repositoryHash: hash,
          skillId: loaded.skillId,
          revision: loaded.revision,
          outcome: "useful",
        },
        principalA,
      ),
    ).resolves.toMatchObject({ recorded: true, outcome: "useful" });
    await expect(
      outcome.execute(
        {
          repositoryHash: hash,
          skillId: "threat-modeling",
          revision: "1.0.0",
          outcome: "useful",
        },
        principalA,
      ),
    ).rejects.toThrow();
  });
});
