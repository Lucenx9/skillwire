import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresSyncLeaseStore } from "../../../src/persistence/postgres/sync-lease-store.js";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../helpers/database.js";

describe("PostgreSQL GitHub job leases", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
  }, 120_000);

  afterAll(async () => database.close());

  it("prevents concurrent holders and fences stale workers after takeover", async () => {
    const store = new PostgresSyncLeaseStore(database.pool);
    const first = await store.acquire("discovery", randomUUID(), 200);
    if (first === undefined) throw new Error("lease not acquired");
    await expect(
      store.acquire("discovery", randomUUID(), 200),
    ).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 225));
    const second = await store.acquire("discovery", randomUUID(), 500);
    if (second === undefined) throw new Error("takeover not acquired");
    expect(second.fencingToken).toBe(first.fencingToken + 1n);
    await expect(store.renew(first, 500)).resolves.toBeUndefined();
    await expect(store.renew(second, 500)).resolves.toMatchObject({
      fencingToken: second.fencingToken,
    });
    await store.release(first);
    await expect(
      store.acquire("discovery", randomUUID(), 500),
    ).resolves.toBeUndefined();
    await store.release(second);
    await expect(
      store.acquire("discovery", randomUUID(), 500),
    ).resolves.toBeDefined();
  });
});
