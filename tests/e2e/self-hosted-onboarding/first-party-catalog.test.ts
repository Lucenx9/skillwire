import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyBundledFirstPartyCatalog } from "../../../src/onboarding/application/first-party-catalog.js";
import { deriveReleaseComponents } from "../../../src/onboarding/domain/release-components.js";
import type { ReleaseManifest } from "../../../src/onboarding/domain/release-manifest.js";
import { createTestApplication } from "../../../src/composition.js";
import {
  loadSkillOutputSchema,
  readSkillResourceOutputSchema,
  searchSkillsOutputSchema,
} from "../../../src/transport/mcp/schemas.js";
import {
  createTestMcpClient,
  type TestMcpClient,
} from "../../helpers/mcp-client.js";

async function catalogPaths(
  root: string,
  relative = "catalog",
): Promise<string[]> {
  const entries = await readdir(resolve(root, relative), {
    withFileTypes: true,
  });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await catalogPaths(root, path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths.toSorted();
}

async function catalogRelease(root: string): Promise<{
  readonly payload: ReleaseManifest["payload"];
  readonly components: Pick<ReleaseManifest["components"], "catalog">;
}> {
  const paths = await catalogPaths(root);
  const payload = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(resolve(root, path));
      return {
        path,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mode: "0644" as const,
      };
    }),
  );
  const compose = {
    path: "distribution/self-hosted/compose.yaml",
    size: 1,
    sha256: "0".repeat(64),
    mode: "0644" as const,
  };
  const migrations = Array.from({ length: 11 }, (_value, index) => ({
    path: `migrations/${String(index + 1).padStart(3, "0")}_fixture.sql`,
    size: 1,
    sha256: String(index).padStart(64, "0"),
    mode: "0644" as const,
  }));
  const adapters = ["codex", "claude"].map((client) => ({
    path: `integrations/${client}/fixture`,
    size: 1,
    sha256: "f".repeat(64),
    mode: "0644" as const,
  }));
  const completePayload = [compose, ...migrations, ...payload, ...adapters];
  return {
    payload: completePayload,
    components: { catalog: deriveReleaseComponents(completePayload).catalog },
  };
}

describe("offline first-party onboarding catalog", () => {
  let client: TestMcpClient | undefined;
  afterEach(async () => client?.close());

  it("verifies and serves the exact ten immutable launch skills without GitHub", async () => {
    const root = process.cwd();
    const fetchImplementation = vi.fn(() => {
      throw new Error("GitHub access is forbidden for first-party setup");
    });

    const verified = await verifyBundledFirstPartyCatalog({
      releaseRoot: root,
      release: await catalogRelease(root),
      fetchImplementation,
    });

    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(verified.releaseId).toBe("launch-catalog-v1");
    expect(verified.revisions).toHaveLength(10);
    expect(new Set(verified.revisions.map(({ skillId }) => skillId)).size).toBe(
      10,
    );
    expect(
      verified.revisions.every(
        ({ bundleSha256, advisoryStatus }) =>
          /^[0-9a-f]{64}$/.test(bundleSha256) &&
          advisoryStatus !== "revoked" &&
          advisoryStatus !== "unavailable",
      ),
    ).toBe(true);

    const selected = verified.provider
      .listMetadata()
      .find(({ id }) => id === "typescript-code-review");
    expect(selected).toBeDefined();
    if (selected === undefined) throw new Error("Smoke skill is missing");
    const loaded = verified.provider.findRevision(
      selected.id,
      selected.revision,
    );
    const identity = verified.revisions.find(
      ({ skillId }) => skillId === selected.id,
    );
    if (identity === undefined) throw new Error("Smoke identity is missing");
    expect(loaded).toMatchObject({
      skillId: selected.id,
      revision: selected.revision,
      bundleSha256: identity.bundleSha256,
    });
    expect(loaded?.publishedProvenance).toBeDefined();

    const { app } = createTestApplication();
    client = await createTestMcpClient(
      new URL("http://localhost/mcp"),
      async (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set("host", "localhost");
        return await app.fetch(new Request(request, { headers }));
      },
    );
    const search = searchSkillsOutputSchema.parse(
      (
        await client.client.callTool({
          name: "search_skills",
          arguments: {
            task: "Review strict TypeScript narrowing and type safety",
            invocationContext: "user-requested",
            limit: 1,
          },
        })
      ).structuredContent,
    );
    const preview = search.skills.at(0);
    expect(preview).toMatchObject({
      skillId: "typescript-code-review",
      currentAdvisoryStatus: "available",
      trustAtPublication: "trusted",
    });
    const skill = loadSkillOutputSchema.parse(
      (
        await client.client.callTool({
          name: "load_skill",
          arguments: {
            skillId: preview?.skillId,
            revision: preview?.revision,
          },
        })
      ).structuredContent,
    );
    const resourceIdentity = skill.resourceManifest.at(0);
    const resource = readSkillResourceOutputSchema.parse(
      (
        await client.client.callTool({
          name: "read_skill_resource",
          arguments: {
            skillId: skill.skillId,
            revision: skill.revision,
            path: resourceIdentity?.path,
          },
        })
      ).structuredContent,
    );
    expect(resource.sha256).toBe(resourceIdentity?.sha256);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
