import { describe, expect, it } from "vitest";

import {
  parseSourceAdminCommand,
  runSourceAdmin,
} from "../../../src/ingestion/admin-cli.js";

describe("registered-source administrator CLI", () => {
  it("accepts repository-level add, list, and exact source sync commands", () => {
    expect(
      parseSourceAdminCommand([
        "source:add",
        "--owner",
        "mattpocock",
        "--repository",
        "skills",
      ]),
    ).toEqual({
      name: "source:add",
      owner: "mattpocock",
      repository: "skills",
    });
    expect(parseSourceAdminCommand(["source:list"])).toEqual({
      name: "source:list",
    });
    expect(
      parseSourceAdminCommand([
        "source:sync",
        "--source-id",
        "550e8400-e29b-41d4-a716-446655440000",
      ]),
    ).toEqual({
      name: "source:sync",
      sourceId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("rejects URLs, refs, individual skills, duplicates, and unknown arguments", () => {
    for (const args of [
      [
        "source:add",
        "--owner",
        "https://github.com/mattpocock",
        "--repository",
        "skills",
      ],
      [
        "source:add",
        "--owner",
        "mattpocock",
        "--repository",
        "skills",
        "--skill",
        "tdd",
      ],
      [
        "source:add",
        "--owner",
        "mattpocock",
        "--repository",
        "skills",
        "--ref",
        "main",
      ],
      ["source:sync", "--source-id", "main"],
      ["source:list", "--all"],
    ]) {
      expect(() => parseSourceAdminCommand(args)).toThrow();
    }
  });

  it("fails closed when required administrator configuration is absent", async () => {
    await expect(runSourceAdmin(["source:list"], {})).rejects.toThrow(
      "INVALID_CONFIGURATION",
    );
  });

  it.each([undefined, "revoked", "expired"])(
    "rejects non-active administrator authority (%s)",
    async (authority) => {
      await expect(
        runSourceAdmin(["source:list"], {
          DATABASE_URL: "postgresql://unused.invalid/skillwire",
          SKILLWIRE_ADMIN_ACTOR_ID: "contract-admin",
          ...(authority === undefined
            ? {}
            : { SKILLWIRE_ADMIN_AUTHORITY: authority }),
        }),
      ).rejects.toThrow("ADMIN_UNAUTHORIZED");
    },
  );
});
