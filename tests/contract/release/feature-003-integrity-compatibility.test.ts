import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CODEX_ADAPTER_SOURCE_COMMIT,
  validateCodexAdapterIntegrityManifest,
} from "../../../src/evaluation/codex-adapter-package.js";

describe("unchanged Feature 003 package identity", () => {
  it("recomputes the 0.1.1 package against its immutable source identity", async () => {
    const manifest = JSON.parse(
      await readFile(
        "distribution/codex-marketplace/release-integrity.json",
        "utf8",
      ),
    ) as unknown;
    const validated = validateCodexAdapterIntegrityManifest(
      manifest,
      "integrations/codex/skillwire-autonomous-activation",
    );
    expect(validated).toMatchObject({
      pluginVersion: "0.1.1",
      packageSha256:
        "f4e2e1cca7b4c99d41d585d2816b44b4203297ad15809e3c1b87bedb8b6e805e",
      source: {
        commit: "7d9fd5fd130c9e66dfb739c599fd84ad9d962d5a",
      },
    });
    expect(validated.source.commit).toBe(CODEX_ADAPTER_SOURCE_COMMIT);
  });
});
