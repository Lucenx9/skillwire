import { describe, expect, it } from "vitest";

import { parseSourceAdminCommand } from "../../../src/ingestion/admin-cli.js";

const candidateId = "550e8400-e29b-41d4-a716-446655440000";

describe("source policy administrator commands", () => {
  it("accepts bounded discovery, filtering, verification, quarantine, and curation grammar", () => {
    expect(parseSourceAdminCommand(["discover"])).toEqual({ name: "discover" });
    expect(
      parseSourceAdminCommand([
        "source:list",
        "--state",
        "quarantined",
        "--limit",
        "25",
      ]),
    ).toEqual({ name: "source:list", state: "quarantined", limit: 25 });
    expect(
      parseSourceAdminCommand(["verify", "--candidate-id", candidateId]),
    ).toEqual({
      name: "verify",
      candidateId,
    });
    expect(
      parseSourceAdminCommand([
        "quarantine",
        "--candidate-id",
        candidateId,
        "--reason-code",
        "ADMIN_QUARANTINE",
      ]),
    ).toEqual({
      name: "quarantine",
      candidateId,
      reasonCode: "ADMIN_QUARANTINE",
    });
    expect(
      parseSourceAdminCommand(["curate", "--candidate-id", candidateId]),
    ).toEqual({
      name: "curate",
      candidateId,
    });
  });

  it("rejects content, repository URLs, mutable refs, individual skills, and arbitrary reasons", () => {
    for (const args of [
      ["discover", "--query", "token"],
      ["verify", "--candidate-id", candidateId, "--content", "unsafe"],
      ["quarantine", "--candidate-id", candidateId, "--reason-code", "because"],
      ["curate", "--candidate-id", candidateId, "--repository", "owner/repo"],
      ["source:list", "--state", "available"],
      ["source:list", "--limit", "101"],
    ]) {
      expect(() => parseSourceAdminCommand(args)).toThrow("INVALID_INPUT");
    }
  });
});
