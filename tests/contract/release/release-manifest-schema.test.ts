import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ReleaseManifestSchema } from "../../../src/onboarding/domain/release-manifest.js";
import {
  bundleV03Fixture,
  releaseManifestFixture,
} from "../../helpers/self-hosted-release-fixtures.js";

describe("external self-hosted release manifest", () => {
  it("binds the archive, complete payload, images, compatibility, and Feature 003 integrity", () => {
    const fixture = releaseManifestFixture();
    expect(ReleaseManifestSchema.parse(fixture)).toEqual(fixture);
    expect(fixture.payload.length).toBeGreaterThan(20);
    expect(fixture.feature003Integrity.path).toBe(
      "distribution/codex-marketplace/release-integrity.json",
    );
    expect(fixture.archive.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.trustPolicy.path).toBe("skillwire-trust-policy-v1.json");
    expect(fixture.trustPolicy.size).toBeGreaterThan(0);
    expect(fixture.trustPolicy.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.publishedAt).toMatch(/Z$/);
  });

  it("rejects undeclared fields and requires a Bundle v0.3 media type", () => {
    expect(() =>
      ReleaseManifestSchema.parse({ ...releaseManifestFixture(), extra: true }),
    ).toThrow();
    expect(bundleV03Fixture(releaseManifestFixture())["mediaType"]).toBe(
      "application/vnd.dev.sigstore.bundle.v0.3+json",
    );
    const schema = JSON.parse(
      readFileSync(
        resolve("distribution/self-hosted/release-manifest.schema.json"),
        "utf8",
      ),
    ) as { $id?: string; additionalProperties?: boolean };
    expect(schema.$id).toBe(
      "https://skillwire.dev/schemas/skillwire.release.v1.json",
    );
    expect(schema.additionalProperties).toBe(false);
  });

  it("rejects non-sibling archives, unbounded archives, duplicate image roles, and platform drift", () => {
    const fixture = releaseManifestFixture();
    expect(() =>
      ReleaseManifestSchema.parse({
        ...fixture,
        archive: { ...fixture.archive, path: "nested/release.tar.zst" },
      }),
    ).toThrow();
    expect(() =>
      ReleaseManifestSchema.parse({
        ...fixture,
        archive: { ...fixture.archive, size: 16 * 1024 ** 3 + 1 },
      }),
    ).toThrow();
    expect(() =>
      ReleaseManifestSchema.parse({
        ...fixture,
        images: [fixture.images[0], fixture.images[0]],
      }),
    ).toThrow();
    expect(() =>
      ReleaseManifestSchema.parse({
        ...fixture,
        images: fixture.images.map((image) => ({
          ...image,
          platform: "linux/arm64",
        })),
      }),
    ).toThrow();
  });
});
