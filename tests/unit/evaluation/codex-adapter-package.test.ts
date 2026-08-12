import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  ADAPTER_POLICY_VERSION,
  CANONICAL_SKILLWIRE_MCP_URL,
  CODEX_ADAPTER_VALIDATOR_VERSION,
  CODEX_MANAGER_VERSION,
  CodexAdapterValidationError,
  SKILLWIRE_PLUGIN_SOURCE_GIT_URL,
  canonicalHashLines,
  createCodexAdapterIntegrityManifest,
  validateCodexAdapterIntegrityManifest,
  validateCodexAdapterPackage,
} from "../../../src/evaluation/codex-adapter-package.js";
import {
  loadActivationFixtures,
  validateActivationFixtures,
} from "../../../src/evaluation/activation-corpus-runner.js";

const projectRoot = process.cwd();
const pluginRoot = join(
  projectRoot,
  "integrations/codex/skillwire-autonomous-activation",
);
const expectedFiles = [
  ".codex-plugin/plugin.json",
  "skills/autonomous-skill-activation/SKILL.md",
  "skills/autonomous-skill-activation/agents/openai.yaml",
];
const temporaryRoots: string[] = [];

function temporaryPlugin(): string {
  const root = mkdtempSync(join(tmpdir(), "skillwire-adapter-package-"));
  temporaryRoots.push(root);
  cpSync(pluginRoot, root, { recursive: true });
  return root;
}

function expectInvalid(root: string, code: string): void {
  try {
    validateCodexAdapterPackage(root);
    throw new Error(`Expected invalid adapter package: ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CodexAdapterValidationError);
    expect((error as CodexAdapterValidationError).codes).toContain(code);
  }
}

describe("Codex activation adapter package", () => {
  afterEach(() => {
    temporaryRoots.splice(0).forEach((root) => {
      rmSync(root, { recursive: true });
    });
  });

  it("accepts exactly three regular, non-executable UTF-8 files", () => {
    const report = validateCodexAdapterPackage(pluginRoot);

    expect(report.pluginName).toBe("skillwire-autonomous-activation");
    expect(report.pluginVersion).toBe("0.1.0");
    expect(report.adapterPolicyVersion).toBe(ADAPTER_POLICY_VERSION);
    expect(report.dependencyUrl).toBe(CANONICAL_SKILLWIRE_MCP_URL);
    expect(report.files.map(({ path }) => path)).toEqual(expectedFiles);
    expect(report.files.every(({ mode }) => (mode & 0o111) === 0)).toBe(true);
  });

  it("rejects extra files, executable files, symlinks, hard links, and invalid UTF-8", () => {
    const extra = temporaryPlugin();
    writeFileSync(join(extra, ".mcp.json"), "{}\n", { mode: 0o600 });
    expectInvalid(extra, "PACKAGE_INVENTORY_INVALID");

    const executable = temporaryPlugin();
    chmodSync(join(executable, ".codex-plugin/plugin.json"), 0o700);
    expectInvalid(executable, "PACKAGE_EXECUTABLE_FILE");

    const symlink = temporaryPlugin();
    unlinkSync(join(symlink, ".codex-plugin/plugin.json"));
    symlinkSync(
      join(pluginRoot, ".codex-plugin/plugin.json"),
      join(symlink, ".codex-plugin/plugin.json"),
    );
    expectInvalid(symlink, "PACKAGE_NON_REGULAR_FILE");

    const hardLink = temporaryPlugin();
    const hardLinkSource = join(hardLink, "manifest-source.json");
    writeFileSync(
      hardLinkSource,
      readFileSync(join(pluginRoot, ".codex-plugin/plugin.json")),
    );
    unlinkSync(join(hardLink, ".codex-plugin/plugin.json"));
    linkSync(hardLinkSource, join(hardLink, ".codex-plugin/plugin.json"));
    expectInvalid(hardLink, "PACKAGE_HARD_LINK");

    const invalidUtf8 = temporaryPlugin();
    writeFileSync(
      join(invalidUtf8, "skills/autonomous-skill-activation/SKILL.md"),
      Buffer.from([0xc3, 0x28]),
    );
    expectInvalid(invalidUtf8, "PACKAGE_UTF8_INVALID");
  });

  it("rejects scripts, payloads, catalog identities, credentials, and repository modification guidance", () => {
    const cases = [
      ["REMOTE_SKILL_CONTENT", "\n## Remote skill\nrevisionSha256: abc\n"],
      ["PACKAGE_SECRET", "\nAuthorization: Bearer fixture-secret\n"],
      [
        "PACKAGE_REPOSITORY_WRITE",
        "\nWrite .codex/config.toml in the repository.\n",
      ],
      [
        "PACKAGE_EXECUTION_GUIDANCE",
        "\nRun npm install and execute the downloaded script.\n",
      ],
    ] as const;

    for (const [code, suffix] of cases) {
      const root = temporaryPlugin();
      const skillPath = join(
        root,
        "skills/autonomous-skill-activation/SKILL.md",
      );
      writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}${suffix}`);
      expectInvalid(root, code);
    }
  });

  it("enforces the exact credential-free skill-level MCP dependency", () => {
    const report = validateCodexAdapterPackage(pluginRoot);
    expect(report.dependency).toEqual({
      type: "mcp",
      value: "skillwire",
      description: "Search and load verified SkillWire guidance",
      transport: "streamable_http",
      url: CANONICAL_SKILLWIRE_MCP_URL,
    });

    const yamlPath = "skills/autonomous-skill-activation/agents/openai.yaml";
    const cases = [
      ["MCP_DEPENDENCY_URL_INVALID", "https://user:pass@skillwire.dev/mcp"],
      ["MCP_DEPENDENCY_URL_INVALID", "https://skillwire.dev/mcp?token=secret"],
      ["MCP_DEPENDENCY_URL_INVALID", "https://skillwire.dev/mcp#fragment"],
      [
        "MCP_DEPENDENCY_URL_INVALID",
        "https://skillwire.dev/tenants/account-1/mcp",
      ],
      ["MCP_DEPENDENCY_URL_INVALID", "CANONICAL_SKILLWIRE_MCP_URL"],
    ] as const;
    for (const [code, url] of cases) {
      const root = temporaryPlugin();
      const path = join(root, yamlPath);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(CANONICAL_SKILLWIRE_MCP_URL, url),
      );
      expectInvalid(root, code);
    }

    const extraDependency = temporaryPlugin();
    const path = join(extraDependency, yamlPath);
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n    - type: "mcp"\n      value: "other"\n      description: "Other"\n      transport: "streamable_http"\n      url: "https://example.test/mcp"\n`,
    );
    expectInvalid(extraDependency, "MCP_DEPENDENCY_INVALID");

    for (const extraField of [
      "      required: true\n",
      '      api_key: "fixture-secret"\n',
      '      credential: "embedded"\n',
    ]) {
      const root = temporaryPlugin();
      const metadataPath = join(root, yamlPath);
      writeFileSync(
        metadataPath,
        `${readFileSync(metadataPath, "utf8")}${extraField}`,
      );
      expectInvalid(root, "MCP_DEPENDENCY_INVALID");
    }
  });

  it("keeps adapter semantics within the centralized server policy boundary", () => {
    const report = validateCodexAdapterPackage(pluginRoot);

    expect(report.semanticChecks).toEqual({
      narrowTriggers: true,
      localPrecedence: true,
      oneAutomaticSearch: true,
      explicitOnlyUserRequested: true,
      exactVerifiedLoad: true,
      progressiveResources: true,
      inertNoInstall: true,
      evidenceGatedOutcome: true,
      failOpenNoRetry: true,
      serverOwnsBehavior: true,
    });
  });

  it("maps specialized clean cases to the bounded attributable workflow without embedding them", () => {
    const fixtures = validateActivationFixtures(
      loadActivationFixtures(projectRoot),
    );
    const skill = readFileSync(
      join(pluginRoot, "skills/autonomous-skill-activation/SKILL.md"),
      "utf8",
    );
    const cleanRelevant = fixtures.corpus.cases.filter(
      (entry) =>
        entry.scenarioClass === "automatic-relevant" &&
        entry.localSkillFixture === undefined &&
        entry.failureMode === undefined,
    );

    expect(cleanRelevant).toHaveLength(30);
    expect(
      cleanRelevant.every(
        ({ expectedBehavior }) =>
          expectedBehavior.search === "call" &&
          expectedBehavior.maxSearchCalls === 1 &&
          expectedBehavior.load === "call" &&
          expectedBehavior.maxLoadCalls === 1 &&
          expectedBehavior.operationSequence[0] === "search_skills" &&
          expectedBehavior.operationSequence[1] === "load_skill",
      ),
    ).toBe(true);
    expect(
      fixtures.corpus.cases
        .filter(({ localSkillFixture }) => localSkillFixture !== undefined)
        .every(({ expectedBehavior }) => expectedBehavior.search === "skip"),
    ).toBe(true);
    for (const activationCase of fixtures.corpus.cases) {
      expect(skill).not.toContain(activationCase.prompt);
    }
    for (const catalogSkill of fixtures.catalog.skills) {
      expect(skill).not.toContain(`\`${catalogSkill.skillId}\``);
    }
  });

  it("builds reproducible ordered integrity metadata bound to source identity", () => {
    const sourceCommit = "1234567890abcdef1234567890abcdef12345678";
    const first = createCodexAdapterIntegrityManifest(pluginRoot, {
      sourceUrl: SKILLWIRE_PLUGIN_SOURCE_GIT_URL,
      sourcePath: "./integrations/codex/skillwire-autonomous-activation",
      sourceCommit,
    });
    const second = createCodexAdapterIntegrityManifest(pluginRoot, {
      sourceUrl: SKILLWIRE_PLUGIN_SOURCE_GIT_URL,
      sourcePath: "./integrations/codex/skillwire-autonomous-activation",
      sourceCommit,
    });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual({
      schemaVersion: 1,
      integrityId: "skillwire-codex-adapter-release-v1",
      pluginName: "skillwire-autonomous-activation",
      pluginVersion: "0.1.0",
      adapterPolicyVersion: "skillwire-codex-adapter-v1",
      source: {
        url: SKILLWIRE_PLUGIN_SOURCE_GIT_URL,
        path: "./integrations/codex/skillwire-autonomous-activation",
        commit: sourceCommit,
      },
      files: first.files,
      packageSha256: first.packageSha256,
      validatorVersion: CODEX_ADAPTER_VALIDATOR_VERSION,
      managerVersion: CODEX_MANAGER_VERSION,
    });
    expect(first.files.map(({ path }) => path)).toEqual(expectedFiles);
    const hashLines = canonicalHashLines(first.files);
    expect(hashLines).toBe(
      first.files.map(({ path, sha256 }) => `${path}\t${sha256}\n`).join(""),
    );
    expect(first.packageSha256).toBe(
      createHash("sha256").update(hashLines).digest("hex"),
    );
    expect(validateCodexAdapterIntegrityManifest(first, pluginRoot)).toEqual(
      first,
    );
  });

  it("rejects stale hashes, package drift at the same version, and invalid source binding", () => {
    const integrity = createCodexAdapterIntegrityManifest(pluginRoot, {
      sourceUrl: SKILLWIRE_PLUGIN_SOURCE_GIT_URL,
      sourcePath: "./integrations/codex/skillwire-autonomous-activation",
      sourceCommit: "1234567890abcdef1234567890abcdef12345678",
    });
    const changed = temporaryPlugin();
    const skillPath = join(
      changed,
      "skills/autonomous-skill-activation/SKILL.md",
    );
    writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}\n`);
    expectInvalidIntegrity(integrity, changed, "INTEGRITY_HASH_MISMATCH");

    const stale = structuredClone(integrity);
    stale.files[0].sha256 = "0".repeat(64);
    expectInvalidIntegrity(stale, pluginRoot, "INTEGRITY_HASH_MISMATCH");

    expect(() =>
      createCodexAdapterIntegrityManifest(pluginRoot, {
        sourceUrl: "https://user@example.test/private.git",
        sourcePath: "../outside",
        sourceCommit: "main",
      }),
    ).toThrow(CodexAdapterValidationError);
  });

  it("exposes safe deterministic validate and manifest CLI output without profile writes", () => {
    const profile = mkdtempSync(join(tmpdir(), "skillwire-adapter-cli-"));
    temporaryRoots.push(profile);
    const home = join(profile, "home");
    const codexHome = join(profile, "codex-home");
    const before = [home, codexHome].map((path) => existsSync(path));
    const tsx = join(projectRoot, "node_modules/.bin/tsx");
    const common = {
      cwd: projectRoot,
      encoding: "utf8" as const,
      env: {
        HOME: home,
        CODEX_HOME: codexHome,
        PATH: process.env["PATH"],
        LANG: "C.UTF-8",
      },
    };
    const validate = spawnSync(
      tsx,
      ["scripts/codex-adapter-package.ts", "validate"],
      common,
    );
    expect(validate.status).toBe(0);
    expect(parseJsonOutput(validate.stdout)).toEqual(
      expect.objectContaining({
        pluginName: "skillwire-autonomous-activation",
        pluginVersion: "0.1.0",
        fileCount: 3,
      }),
    );

    const manifest = spawnSync(
      tsx,
      [
        "scripts/codex-adapter-package.ts",
        "manifest",
        "--source-commit",
        "1234567890abcdef1234567890abcdef12345678",
      ],
      common,
    );
    expect(manifest.status).toBe(0);
    const manifestOutput = parseJsonOutput(manifest.stdout);
    expect(manifestOutput).toMatchObject({
      integrityId: "skillwire-codex-adapter-release-v1",
    });
    expect(isRecord(manifestOutput)).toBe(true);
    if (!isRecord(manifestOutput)) throw new Error("expected manifest object");
    expect(manifestOutput["packageSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect([home, codexHome].map((path) => existsSync(path))).toEqual(before);
    expect(
      `${validate.stdout}${validate.stderr}${manifest.stdout}${manifest.stderr}`,
    ).not.toMatch(/(?:authorization|bearer\s+|api[_-]?key|credential)/i);
  });
});

function expectInvalidIntegrity(
  value: unknown,
  root: string,
  code: string,
): void {
  try {
    validateCodexAdapterIntegrityManifest(value, root);
    throw new Error(`Expected invalid integrity manifest: ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CodexAdapterValidationError);
    expect((error as CodexAdapterValidationError).codes).toContain(code);
  }
}

function parseJsonOutput(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
