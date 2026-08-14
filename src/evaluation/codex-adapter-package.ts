import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ADAPTER_POLICY_VERSION = "skillwire-codex-adapter-v1";
export const CODEX_ADAPTER_VALIDATOR_VERSION = "codex-adapter-validator-v1";
export const CANONICAL_SKILLWIRE_MCP_URL = "https://skillwire.dev/mcp";
export const CODEX_MANAGER_VERSION = "0.147.0";
export const CODEX_ADAPTER_PLUGIN_NAME = "skillwire-autonomous-activation";
export const CODEX_ADAPTER_SKILL_NAME = "autonomous-skill-activation";
export const SKILLWIRE_PLUGIN_SOURCE_GIT_URL =
  "https://github.com/Lucenx9/skillwire.git";
export const CODEX_ADAPTER_SOURCE_PATH =
  "./integrations/codex/skillwire-autonomous-activation";
export const CODEX_ADAPTER_SOURCE_COMMIT =
  "7d9fd5fd130c9e66dfb739c599fd84ad9d962d5a";

export const CODEX_ADAPTER_FILES = [
  ".codex-plugin/plugin.json",
  "skills/autonomous-skill-activation/SKILL.md",
  "skills/autonomous-skill-activation/agents/openai.yaml",
] as const;

const ALLOWED_DIRECTORIES = new Set([
  ".codex-plugin",
  "skills",
  "skills/autonomous-skill-activation",
  "skills/autonomous-skill-activation/agents",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXPECTED_DESCRIPTION =
  "For non-routine specialist tasks, named technology workflows, formal reviews or evaluations, safety or compliance procedures, and specialized deliverables where verified procedural guidance could materially improve the result. Do not use for greetings, trivial calculations or transformations, routine generic coding or writing, repeated intent, tasks already covered by sufficient local or loaded guidance, or tasks that cannot be summarized without sensitive data.";
// The skill body is executable guidance, so accepting text based only on the
// presence of required phrases would allow contradictory instructions to be
// appended. Changes to the policy must be explicitly approved by updating this
// digest alongside the canonical adapter.
const APPROVED_SKILL_BODY_SHA256 =
  "549ac28348f6021d086bc14409cfb21b67c92a1109e2edb60b2290ec52028b89";

const pluginManifestSchema = z
  .object({
    name: z.literal(CODEX_ADAPTER_PLUGIN_NAME),
    version: z.string().max(64).regex(SEMVER_PATTERN),
    description: z.literal(
      "Helps Codex consult relevant verified SkillWire guidance for specialized tasks.",
    ),
    skills: z.literal("./skills/"),
  })
  .strict();

const dependencySchema = z
  .object({
    type: z.literal("mcp"),
    value: z.literal("skillwire"),
    description: z.literal("Search and load verified SkillWire guidance"),
    transport: z.literal("streamable_http"),
    url: z.literal(CANONICAL_SKILLWIRE_MCP_URL),
  })
  .strict();

const openAiMetadataSchema = z
  .object({
    interface: z
      .object({
        display_name: z.literal("SkillWire Activation"),
        short_description: z.literal("Find verified skill guidance"),
      })
      .strict(),
    policy: z
      .object({
        products: z.tuple([z.literal("CODEX")]),
        allow_implicit_invocation: z.literal(true),
      })
      .strict(),
    dependencies: z.object({ tools: z.tuple([dependencySchema]) }).strict(),
  })
  .strict();

const marketplaceSchema = z
  .object({
    name: z.literal("skillwire"),
    interface: z.object({ displayName: z.literal("SkillWire") }).strict(),
    plugins: z.tuple([
      z
        .object({
          name: z.literal(CODEX_ADAPTER_PLUGIN_NAME),
          source: z
            .object({
              source: z.literal("git-subdir"),
              url: z.literal(SKILLWIRE_PLUGIN_SOURCE_GIT_URL),
              path: z.literal(CODEX_ADAPTER_SOURCE_PATH),
              sha: z.string().regex(/^[0-9a-f]{40}$/),
            })
            .strict(),
          policy: z
            .object({
              installation: z.literal("AVAILABLE"),
              authentication: z.literal("ON_USE"),
            })
            .strict(),
          category: z.literal("Developer Tools"),
        })
        .strict(),
    ]),
  })
  .strict();

const integrityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    integrityId: z.literal("skillwire-codex-adapter-release-v1"),
    pluginName: z.literal(CODEX_ADAPTER_PLUGIN_NAME),
    pluginVersion: z.string().max(64).regex(SEMVER_PATTERN),
    adapterPolicyVersion: z.literal(ADAPTER_POLICY_VERSION),
    source: z
      .object({
        url: z.literal(SKILLWIRE_PLUGIN_SOURCE_GIT_URL),
        path: z.literal(CODEX_ADAPTER_SOURCE_PATH),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
      })
      .strict(),
    files: z.tuple([
      z
        .object({
          path: z.literal(CODEX_ADAPTER_FILES[0]),
          sha256: z.string().regex(SHA256_PATTERN),
        })
        .strict(),
      z
        .object({
          path: z.literal(CODEX_ADAPTER_FILES[1]),
          sha256: z.string().regex(SHA256_PATTERN),
        })
        .strict(),
      z
        .object({
          path: z.literal(CODEX_ADAPTER_FILES[2]),
          sha256: z.string().regex(SHA256_PATTERN),
        })
        .strict(),
    ]),
    packageSha256: z.string().regex(SHA256_PATTERN),
    validatorVersion: z.literal(CODEX_ADAPTER_VALIDATOR_VERSION),
    managerVersion: z.literal(CODEX_MANAGER_VERSION),
  })
  .strict();

export interface CodexAdapterFileReport {
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
}

export interface CodexAdapterSemanticChecks {
  readonly narrowTriggers: true;
  readonly localPrecedence: true;
  readonly oneAutomaticSearch: true;
  readonly explicitOnlyUserRequested: true;
  readonly exactVerifiedLoad: true;
  readonly progressiveResources: true;
  readonly inertNoInstall: true;
  readonly evidenceGatedOutcome: true;
  readonly failOpenNoRetry: true;
  readonly serverOwnsBehavior: true;
}

export interface CodexAdapterPackageReport {
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly adapterPolicyVersion: string;
  readonly dependencyUrl: string;
  readonly dependency: z.infer<typeof dependencySchema>;
  readonly files: readonly CodexAdapterFileReport[];
  readonly packageSha256: string;
  readonly semanticChecks: CodexAdapterSemanticChecks;
}

export interface CodexMarketplaceReport {
  readonly marketplaceName: "skillwire";
  readonly pluginName: typeof CODEX_ADAPTER_PLUGIN_NAME;
  readonly sourceUrl: typeof SKILLWIRE_PLUGIN_SOURCE_GIT_URL;
  readonly sourcePath: typeof CODEX_ADAPTER_SOURCE_PATH;
  readonly sourceCommit: string;
  readonly installation: "AVAILABLE";
  readonly authentication: "ON_USE";
  readonly category: "Developer Tools";
}

export type CodexAdapterIntegrityManifest = z.infer<
  typeof integrityManifestSchema
>;

export interface CodexAdapterSourceIdentity {
  readonly sourceUrl: string;
  readonly sourcePath: string;
  readonly sourceCommit: string;
}

export class CodexAdapterValidationError extends Error {
  public constructor(readonly codes: readonly string[]) {
    super(codes.join(","));
    this.name = "CodexAdapterValidationError";
  }
}

export function validateCodexAdapterPackage(
  pluginRoot: string,
): CodexAdapterPackageReport {
  const codes = new Set<string>();
  const root = resolve(pluginRoot);
  const entries = collectEntries(root, codes);
  const files = entries.filter(({ kind }) => kind === "file");
  const paths = files.map(({ path }) => path).sort();
  if (
    paths.length !== CODEX_ADAPTER_FILES.length ||
    paths.some((path, index) => path !== CODEX_ADAPTER_FILES[index])
  ) {
    codes.add("PACKAGE_INVENTORY_INVALID");
  }
  for (const entry of entries) {
    if (entry.kind === "directory" && !ALLOWED_DIRECTORIES.has(entry.path)) {
      codes.add("PACKAGE_INVENTORY_INVALID");
    }
    if (entry.kind === "other") codes.add("PACKAGE_NON_REGULAR_FILE");
  }

  const textByPath = new Map<string, string>();
  const reports: CodexAdapterFileReport[] = [];
  for (const path of CODEX_ADAPTER_FILES) {
    const entry = files.find((candidate) => candidate.path === path);
    if (entry === undefined) continue;
    if ((entry.mode & 0o111) !== 0) codes.add("PACKAGE_EXECUTABLE_FILE");
    if (entry.links > 1) codes.add("PACKAGE_HARD_LINK");
    const bytes = readFileSync(join(root, path));
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      codes.add("PACKAGE_UTF8_INVALID");
    }
    if (text !== undefined) textByPath.set(path, text);
    reports.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mode: entry.mode,
    });
  }

  const manifest = parsePluginManifest(textByPath, codes);
  const skill = parseSkill(textByPath, codes);
  const metadata = parseOpenAiMetadata(textByPath, codes);
  scanPackageText(textByPath, codes);
  validateApprovedSkillBody(skill.body, codes);
  const semanticChecks = validateSemantics(skill.body, codes);
  const sortedReports = reports.sort((left, right) =>
    comparePaths(left.path, right.path),
  );
  const packageSha256 = createHash("sha256")
    .update(canonicalHashLines(sortedReports))
    .digest("hex");

  if (codes.size > 0) {
    throw new CodexAdapterValidationError([...codes].sort());
  }
  if (manifest === undefined || metadata === undefined) {
    throw new CodexAdapterValidationError(["PACKAGE_SCHEMA_INVALID"]);
  }
  return {
    pluginName: manifest.name,
    pluginVersion: manifest.version,
    adapterPolicyVersion: ADAPTER_POLICY_VERSION,
    dependencyUrl: metadata.dependencies.tools[0].url,
    dependency: metadata.dependencies.tools[0],
    files: sortedReports,
    packageSha256,
    semanticChecks,
  };
}

export function createCodexMarketplace(sourceCommit: string): {
  name: "skillwire";
  interface: { displayName: "SkillWire" };
  plugins: {
    name: string;
    source: {
      source: string;
      url: string;
      path: string;
      sha: string;
    };
    policy: { installation: string; authentication: string };
    category: string;
  }[];
} {
  return {
    name: "skillwire",
    interface: { displayName: "SkillWire" },
    plugins: [
      {
        name: CODEX_ADAPTER_PLUGIN_NAME,
        source: {
          source: "git-subdir",
          url: SKILLWIRE_PLUGIN_SOURCE_GIT_URL,
          path: CODEX_ADAPTER_SOURCE_PATH,
          sha: sourceCommit,
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_USE",
        },
        category: "Developer Tools",
      },
    ],
  };
}

export function validateCodexMarketplace(
  value: unknown,
  plugin: CodexAdapterPackageReport,
): CodexMarketplaceReport {
  const codes = new Set<string>();
  const rawEntry = getMarketplaceEntry(value);
  if (rawEntry !== undefined) {
    if (rawEntry["name"] !== plugin.pluginName) {
      codes.add("MARKETPLACE_IDENTITY_MISMATCH");
    }
    const source = rawEntry["source"];
    if (isRecord(source)) {
      const sha = source["sha"];
      if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
        codes.add("MARKETPLACE_SOURCE_COMMIT_INVALID");
      }
      if (!isCredentialFreeGitUrl(source["url"])) {
        codes.add("MARKETPLACE_SOURCE_URL_INVALID");
      }
      if (source["path"] !== CODEX_ADAPTER_SOURCE_PATH) {
        codes.add("MARKETPLACE_SOURCE_PATH_INVALID");
      }
    }
  }
  const parsed = marketplaceSchema.safeParse(value);
  if (!parsed.success) codes.add("MARKETPLACE_SCHEMA_INVALID");
  if (codes.size > 0 || !parsed.success) {
    throw new CodexAdapterValidationError([...codes].sort());
  }
  const entry = parsed.data.plugins[0];
  return {
    marketplaceName: parsed.data.name,
    pluginName: entry.name,
    sourceUrl: entry.source.url,
    sourcePath: entry.source.path,
    sourceCommit: entry.source.sha,
    installation: entry.policy.installation,
    authentication: entry.policy.authentication,
    category: entry.category,
  };
}

export function createCodexAdapterIntegrityManifest(
  pluginRoot: string,
  source: CodexAdapterSourceIdentity,
): CodexAdapterIntegrityManifest {
  if (
    source.sourceUrl !== SKILLWIRE_PLUGIN_SOURCE_GIT_URL ||
    !isCredentialFreeGitUrl(source.sourceUrl) ||
    source.sourcePath !== CODEX_ADAPTER_SOURCE_PATH ||
    !/^[0-9a-f]{40}$/.test(source.sourceCommit)
  ) {
    throw new CodexAdapterValidationError(["INTEGRITY_SOURCE_INVALID"]);
  }
  const report = validateCodexAdapterPackage(pluginRoot);
  return integrityManifestSchema.parse({
    schemaVersion: 1,
    integrityId: "skillwire-codex-adapter-release-v1",
    pluginName: report.pluginName,
    pluginVersion: report.pluginVersion,
    adapterPolicyVersion: report.adapterPolicyVersion,
    source: {
      url: source.sourceUrl,
      path: source.sourcePath,
      commit: source.sourceCommit,
    },
    files: report.files.map(({ path, sha256 }) => ({ path, sha256 })),
    packageSha256: report.packageSha256,
    validatorVersion: CODEX_ADAPTER_VALIDATOR_VERSION,
    managerVersion: CODEX_MANAGER_VERSION,
  });
}

export function validateCodexAdapterIntegrityManifest(
  value: unknown,
  pluginRoot: string,
): CodexAdapterIntegrityManifest {
  const parsed = integrityManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new CodexAdapterValidationError(["INTEGRITY_SCHEMA_INVALID"]);
  }
  const report = validateCodexAdapterPackage(pluginRoot);
  const expectedFiles = report.files.map(({ path, sha256 }) => ({
    path,
    sha256,
  }));
  if (
    parsed.data.pluginVersion !== report.pluginVersion ||
    parsed.data.packageSha256 !== report.packageSha256 ||
    JSON.stringify(parsed.data.files) !== JSON.stringify(expectedFiles)
  ) {
    throw new CodexAdapterValidationError(["INTEGRITY_HASH_MISMATCH"]);
  }
  return parsed.data;
}

function getMarketplaceEntry(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const plugins = value["plugins"];
  if (!Array.isArray(plugins) || plugins.length === 0) return undefined;
  const first: unknown = plugins[0];
  return isRecord(first) ? first : undefined;
}

function isCredentialFreeGitUrl(value: unknown): boolean {
  if (typeof value !== "string" || value !== SKILLWIRE_PLUGIN_SOURCE_GIT_URL)
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function collectEntries(
  root: string,
  codes: Set<string>,
): {
  path: string;
  kind: "directory" | "file" | "other";
  mode: number;
  links: number;
}[] {
  const entries: {
    path: string;
    kind: "directory" | "file" | "other";
    mode: number;
    links: number;
  }[] = [];
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw new CodexAdapterValidationError(["PACKAGE_NOT_FOUND"]);
  }
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        codes.add("PACKAGE_NON_REGULAR_FILE");
        entries.push({
          path,
          kind: "other",
          mode: stat.mode,
          links: stat.nlink,
        });
        continue;
      }
      const resolvedParent = realpathSync(dirname(absolute));
      if (
        resolvedParent !== rootReal &&
        !resolvedParent.startsWith(`${rootReal}${sep}`)
      ) {
        codes.add("PACKAGE_PATH_ESCAPE");
      }
      if (stat.isDirectory()) {
        entries.push({
          path,
          kind: "directory",
          mode: stat.mode,
          links: stat.nlink,
        });
        visit(absolute);
      } else if (stat.isFile()) {
        entries.push({
          path,
          kind: "file",
          mode: stat.mode,
          links: stat.nlink,
        });
      } else {
        entries.push({
          path,
          kind: "other",
          mode: stat.mode,
          links: stat.nlink,
        });
      }
    }
  };
  visit(root);
  return entries;
}

function parsePluginManifest(
  textByPath: ReadonlyMap<string, string>,
  codes: Set<string>,
): z.infer<typeof pluginManifestSchema> | undefined {
  try {
    return pluginManifestSchema.parse(
      JSON.parse(textByPath.get(".codex-plugin/plugin.json") ?? ""),
    );
  } catch {
    codes.add("PLUGIN_MANIFEST_INVALID");
    return undefined;
  }
}

function parseSkill(
  textByPath: ReadonlyMap<string, string>,
  codes: Set<string>,
): { body: string } {
  const text =
    textByPath.get("skills/autonomous-skill-activation/SKILL.md") ?? "";
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(text);
  if (match === null) {
    codes.add("SKILL_FRONTMATTER_INVALID");
    return { body: "" };
  }
  try {
    const frontmatter = z
      .object({
        name: z.literal(CODEX_ADAPTER_SKILL_NAME),
        description: z.literal(EXPECTED_DESCRIPTION),
      })
      .strict()
      .parse(parseYaml(match[1] ?? ""));
    if (
      `${frontmatter.name}:${frontmatter.description}`.length === 0 ||
      match[2]?.trim().length === 0
    ) {
      codes.add("SKILL_FRONTMATTER_INVALID");
    }
  } catch {
    codes.add("SKILL_FRONTMATTER_INVALID");
  }
  return { body: match[2] ?? "" };
}

function parseOpenAiMetadata(
  textByPath: ReadonlyMap<string, string>,
  codes: Set<string>,
): z.infer<typeof openAiMetadataSchema> | undefined {
  const text =
    textByPath.get("skills/autonomous-skill-activation/agents/openai.yaml") ??
    "";
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    codes.add("OPENAI_METADATA_INVALID");
    return undefined;
  }
  const generic = z
    .looseObject({ dependencies: z.object({ tools: z.array(z.unknown()) }) })
    .safeParse(raw);
  if (!generic.success || generic.data.dependencies.tools.length !== 1) {
    codes.add("MCP_DEPENDENCY_INVALID");
  }
  const url = extractDependencyUrl(raw);
  if (!isCredentialFreeCanonicalUrl(url)) {
    codes.add("MCP_DEPENDENCY_URL_INVALID");
  }
  const parsed = openAiMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    codes.add("OPENAI_METADATA_INVALID");
    if (generic.success) codes.add("MCP_DEPENDENCY_INVALID");
    return undefined;
  }
  return parsed.data;
}

function extractDependencyUrl(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const dependencies = value["dependencies"];
  if (!isRecord(dependencies)) return undefined;
  const tools = dependencies["tools"];
  if (!Array.isArray(tools) || tools.length !== 1) return undefined;
  const dependency: unknown = tools[0];
  if (!isRecord(dependency)) return undefined;
  return dependency["url"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCredentialFreeCanonicalUrl(value: unknown): boolean {
  if (typeof value !== "string" || value !== CANONICAL_SKILLWIRE_MCP_URL)
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      !/(?:placeholder|example|tenant|account|repository|token|key)/i.test(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}

function scanPackageText(
  textByPath: ReadonlyMap<string, string>,
  codes: Set<string>,
): void {
  const text = [...textByPath.values()].join("\n");
  if (
    /(?:authorization\s*:|bearer\s+[A-Za-z0-9._-]+|api[_-]?key\s*[:=]|-----BEGIN|client[_-]?secret\s*[:=])/i.test(
      text,
    )
  ) {
    codes.add("PACKAGE_SECRET");
  }
  if (
    /(?:revisionSha256\s*:|catalog entry|remote skill payload|resource body\s*:)/i.test(
      text,
    )
  ) {
    codes.add("REMOTE_SKILL_CONTENT");
  }
  if (
    /(?:write|create|modify|copy)[^\n]{0,80}(?:\.codex\/|\.agents\/|AGENTS\.md)/i.test(
      text,
    )
  ) {
    codes.add("PACKAGE_REPOSITORY_WRITE");
  }
  if (
    /(?:npm|pnpm|yarn) install|execute the downloaded|run the downloaded script/i.test(
      text,
    )
  ) {
    codes.add("PACKAGE_EXECUTION_GUIDANCE");
  }
}

function validateSemantics(
  body: string,
  codes: Set<string>,
): CodexAdapterSemanticChecks {
  const normalized = body.replaceAll("`", "").replace(/\s+/g, " ");
  const checks = {
    narrowTriggers:
      /non-routine specialized task/i.test(normalized) &&
      /greetings, trivial calculations or transformations, and routine generic work/i.test(
        normalized,
      ),
    localPrecedence: /local or already-loaded guidance is sufficient/i.test(
      normalized,
    ),
    oneAutomaticSearch:
      /one minimal, non-sensitive search_skills call/i.test(normalized) &&
      /invocationContext: automatic/i.test(normalized),
    explicitOnlyUserRequested:
      /user-requested only when the active user explicitly requests/i.test(
        normalized,
      ),
    exactVerifiedLoad:
      /one relevant preview/i.test(normalized) &&
      /exact skillId and revision/i.test(normalized) &&
      /hash, provenance, and advisory status/i.test(normalized),
    progressiveResources:
      /next specifically useful declared resource/i.test(normalized) &&
      /once per path/i.test(normalized),
    inertNoInstall:
      /untrusted, inert data/i.test(normalized) &&
      /never install or execute it/i.test(normalized) &&
      /writes no client or repository files/i.test(normalized),
    evidenceGatedOutcome:
      /positive outcome only after completed-task evidence or explicit user feedback/i.test(
        normalized,
      ),
    failOpenNoRetry:
      /continue normal work/i.test(normalized) &&
      /no retry, reformulation, polling, context escalation, revision substitution, or second candidate/i.test(
        normalized,
      ),
    serverOwnsBehavior:
      /SkillWire MCP server owns search, ranking, loading, resource retrieval, provenance, integrity, authentication, tenancy, and memory/i.test(
        normalized,
      ),
  } as const;
  if (Object.values(checks).some((value) => !value)) {
    codes.add("ADAPTER_POLICY_INCOMPLETE");
  }
  return checks as CodexAdapterSemanticChecks;
}

function validateApprovedSkillBody(body: string, codes: Set<string>): void {
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== APPROVED_SKILL_BODY_SHA256) {
    codes.add("ADAPTER_POLICY_UNAPPROVED");
  }
}

export function canonicalHashLines(
  files: readonly Pick<CodexAdapterFileReport, "path" | "sha256">[],
): string {
  return [...files]
    .sort((left, right) => comparePaths(left.path, right.path))
    .map(({ path, sha256 }) => `${path}\t${sha256}\n`)
    .join("");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function assertPathInside(root: string, candidate: string): void {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    basename(candidate) === ""
  ) {
    throw new CodexAdapterValidationError(["PACKAGE_PATH_ESCAPE"]);
  }
}
