import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAdapterValidationError,
  CODEX_ADAPTER_SOURCE_COMMIT,
  SKILLWIRE_PLUGIN_SOURCE_GIT_URL,
  createCodexMarketplace,
  validateCodexAdapterPackage,
  validateCodexMarketplace,
} from "../../../src/evaluation/codex-adapter-package.js";

const projectRoot = process.cwd();
const pluginRoot = join(
  projectRoot,
  "integrations/codex/skillwire-autonomous-activation",
);
const sourceCommit = "1234567890abcdef1234567890abcdef12345678";
const temporaryRoots: string[] = [];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectInvalid(value: unknown, code: string): void {
  const plugin = validateCodexAdapterPackage(pluginRoot);
  try {
    validateCodexMarketplace(value, plugin);
    throw new Error(`Expected invalid marketplace: ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CodexAdapterValidationError);
    expect((error as CodexAdapterValidationError).codes).toContain(code);
  }
}

describe("SkillWire Codex marketplace metadata", () => {
  afterEach(() => {
    temporaryRoots.splice(0).forEach((root) => {
      rmSync(root, { recursive: true });
    });
  });

  it("accepts one immutable, credential-free git-subdir plugin entry", () => {
    const plugin = validateCodexAdapterPackage(pluginRoot);
    const marketplace = createCodexMarketplace(sourceCommit);
    const report = validateCodexMarketplace(marketplace, plugin);

    expect(report).toEqual({
      marketplaceName: "skillwire",
      pluginName: "skillwire-autonomous-activation",
      sourceUrl: SKILLWIRE_PLUGIN_SOURCE_GIT_URL,
      sourcePath: "./integrations/codex/skillwire-autonomous-activation",
      sourceCommit,
      installation: "AVAILABLE",
      authentication: "ON_USE",
      category: "Developer Tools",
    });
  });

  it("rejects mutable, placeholder, credential-bearing, and escaping sources", () => {
    const base = createCodexMarketplace(sourceCommit);
    const cases: {
      code: string;
      mutate(value: ReturnType<typeof createCodexMarketplace>): void;
    }[] = [
      {
        code: "MARKETPLACE_SOURCE_COMMIT_INVALID",
        mutate(value) {
          firstPlugin(value).source.sha = "main";
        },
      },
      {
        code: "MARKETPLACE_SOURCE_COMMIT_INVALID",
        mutate(value) {
          firstPlugin(value).source.sha = "PLUGIN_SOURCE_COMMIT_SHA";
        },
      },
      {
        code: "MARKETPLACE_SOURCE_URL_INVALID",
        mutate(value) {
          firstPlugin(value).source.url =
            "https://token@github.com/Lucenx9/skillwire.git";
        },
      },
      {
        code: "MARKETPLACE_SOURCE_URL_INVALID",
        mutate(value) {
          firstPlugin(value).source.url =
            `${SKILLWIRE_PLUGIN_SOURCE_GIT_URL}?token=secret`;
        },
      },
      {
        code: "MARKETPLACE_SOURCE_PATH_INVALID",
        mutate(value) {
          firstPlugin(value).source.path = "./../outside";
        },
      },
      {
        code: "MARKETPLACE_IDENTITY_MISMATCH",
        mutate(value) {
          firstPlugin(value).name = "other-plugin";
        },
      },
    ];

    for (const entry of cases) {
      const value = clone(base);
      entry.mutate(value);
      expectInvalid(value, entry.code);
    }
  });

  it("rejects extra entries, fields, and policy drift", () => {
    const extraEntry = createCodexMarketplace(sourceCommit);
    extraEntry.plugins.push(clone(firstPlugin(extraEntry)));
    expectInvalid(extraEntry, "MARKETPLACE_SCHEMA_INVALID");

    const wrongPolicy = createCodexMarketplace(sourceCommit);
    firstPlugin(wrongPolicy).policy.authentication = "ON_INSTALL";
    expectInvalid(wrongPolicy, "MARKETPLACE_SCHEMA_INVALID");

    const extraField = createCodexMarketplace(sourceCommit) as ReturnType<
      typeof createCodexMarketplace
    > & { repositoryActivationFile?: string };
    extraField.repositoryActivationFile = ".agents/plugins/marketplace.json";
    expectInvalid(extraField, "MARKETPLACE_SCHEMA_INVALID");
  });

  it("stages the exact release input only in a dedicated marketplace checkout", () => {
    const releasePath = join(
      projectRoot,
      "distribution/codex-marketplace/marketplace.json",
    );
    const release = JSON.parse(readFileSync(releasePath, "utf8")) as unknown;
    const plugin = validateCodexAdapterPackage(pluginRoot);
    const report = validateCodexMarketplace(release, plugin);
    expect(report.sourceCommit).toBe(CODEX_ADAPTER_SOURCE_COMMIT);

    const publication = mkdtempSync(
      join(tmpdir(), "skillwire-marketplace-publication-"),
    );
    temporaryRoots.push(publication);
    const publicationPath = join(
      publication,
      ".agents/plugins/marketplace.json",
    );
    mkdirSync(dirname(publicationPath), { recursive: true, mode: 0o700 });
    cpSync(releasePath, publicationPath);
    expect(
      validateCodexMarketplace(
        JSON.parse(readFileSync(publicationPath, "utf8")) as unknown,
        plugin,
      ),
    ).toEqual(report);
    expect(existsSync(join(projectRoot, ".agents/plugins"))).toBe(false);
    expect(existsSync(join(projectRoot, ".codex"))).toBe(false);
  });
});

function firstPlugin(value: ReturnType<typeof createCodexMarketplace>) {
  const plugin = value.plugins[0];
  if (plugin === undefined)
    throw new Error("Expected marketplace plugin fixture");
  return plugin;
}
