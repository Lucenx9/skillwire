import { describe, expect, it } from "vitest";

import {
  canonicalizeRevision,
  createSkillRevision,
} from "../../../src/domain/catalog/canonical-revision.js";
import { normalizeUtf8 } from "../../../src/domain/catalog/text-normalization.js";

const provenance = {
  source: { provider: "git", reference: "skillwire/example" },
  sourceRevision: "1.0.0",
  owner: "SkillWire maintainers",
  license: "Apache-2.0" as const,
  trustAtPublication: "trusted" as const,
};

describe("canonical revisions", () => {
  it("normalizes strict UTF-8 before hashing", () => {
    const normalized = normalizeUtf8(
      Buffer.from("\uFEFFcaf\u0065\u0301\r\n", "utf8"),
    );

    expect(normalized).toEqual({ text: "café\n", byteLength: 6 });
  });

  it("produces stable resource and complete-bundle hashes", () => {
    const first = createSkillRevision({
      skillId: "example-skill",
      revision: "1.0.0",
      publishedProvenance: provenance,
      instructions: "# Example\n",
      resources: [
        {
          path: "references/checklist.md",
          mediaType: "text/markdown",
          content: "hello\n",
        },
      ],
    });
    const second = createSkillRevision({
      skillId: "example-skill",
      revision: "1.0.0",
      publishedProvenance: provenance,
      instructions: "# Example\n",
      resources: [
        {
          path: "references/checklist.md",
          mediaType: "text/markdown",
          content: "hello\n",
        },
      ],
    });

    expect(first.resourceManifest[0]?.sha256).toBe(
      "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    );
    expect(first.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toEqual(second);
    expect(canonicalizeRevision(first)).toBe(canonicalizeRevision(second));
  });

  it("binds instructions, resources, and provenance into the bundle hash", () => {
    const base = {
      skillId: "example-skill",
      revision: "1.0.0",
      publishedProvenance: provenance,
      instructions: "# Example\n",
      resources: [
        {
          path: "references/checklist.md",
          mediaType: "text/markdown" as const,
          content: "hello\n",
        },
      ],
    };

    const original = createSkillRevision(base).bundleSha256;
    expect(
      createSkillRevision({ ...base, instructions: "# Changed\n" })
        .bundleSha256,
    ).not.toBe(original);
    expect(
      createSkillRevision({
        ...base,
        publishedProvenance: { ...provenance, sourceRevision: "1.0.1" },
      }).bundleSha256,
    ).not.toBe(original);
    expect(
      createSkillRevision({
        ...base,
        resources: [
          {
            path: "references/checklist.md",
            mediaType: "text/markdown",
            content: "changed\n",
          },
        ],
      }).bundleSha256,
    ).not.toBe(original);
  });
});
