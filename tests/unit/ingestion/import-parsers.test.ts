import { describe, expect, it } from "vitest";

import { parseClaudePluginManifest } from "../../../src/ingestion/parsing/claude-plugin-manifest.js";
import { parseSkillDocument } from "../../../src/ingestion/parsing/frontmatter.js";
import { extractTextualResourceReferences } from "../../../src/ingestion/parsing/markdown-resources.js";
import { createGitHubIngestionFixture } from "../../helpers/github-ingestion-fixture.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("registered-source import parsers", () => {
  it("validates all 25 authoritative plugin entries", async () => {
    const fixture = await createGitHubIngestionFixture();
    const file = fixture.files.get(".claude-plugin/plugin.json");
    if (file === undefined) throw new Error("Fixture manifest missing");
    const manifest = parseClaudePluginManifest(bytes(file.content));
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.license).toBe("MIT");
    expect(manifest.author).toBe("Matt Pocock");
    expect(manifest.skillRoots).toHaveLength(25);
  });

  it("preserves exact boolean invocation metadata and dependency evidence", async () => {
    const fixture = await createGitHubIngestionFixture();
    const ask = fixture.files.get("skills/engineering/ask-matt/SKILL.md");
    const grill = fixture.files.get(
      "skills/engineering/grill-with-docs/SKILL.md",
    );
    if (ask === undefined || grill === undefined)
      throw new Error("Fixture skill missing");
    expect(parseSkillDocument(bytes(ask.content)).invocationMode).toBe(
      "user-only",
    );
    expect(
      parseSkillDocument(bytes(grill.content)).dependencyEvidence.map(
        ({ skillName }) => skillName,
      ),
    ).toEqual(["domain-modeling", "grilling"]);
    expect(
      parseSkillDocument(
        bytes(
          "---\nname: example\ndescription: Example.\n---\n\n```text\n/grilling\n```\n",
        ),
      ).dependencyEvidence,
    ).toEqual([]);
  });

  it("extracts only inert safe Markdown and text resources", () => {
    expect(
      extractTextualResourceReferences(
        [
          "[Guide](guide.md)",
          "[Notes][notes]",
          "",
          "[notes]: notes.txt",
          "[script](template.sh)",
          "![image](image.md)",
          "`[code](secret.md)`",
          "<a href='html.md'>html</a>",
        ].join("\n"),
        "skills/example/SKILL.md",
      ),
    ).toEqual([
      {
        manifestPath: "guide.md",
        repositoryPath: "skills/example/guide.md",
        mediaType: "text/markdown",
      },
      {
        manifestPath: "notes.txt",
        repositoryPath: "skills/example/notes.txt",
        mediaType: "text/plain",
      },
    ]);
    expect(() =>
      extractTextualResourceReferences(
        "[escape](../secret.md)",
        "skills/example/SKILL.md",
      ),
    ).toThrow("PATH_UNSAFE");
    expect(() =>
      extractTextualResourceReferences(
        "[encoded](%2e%2e/secret.md)",
        "skills/example/SKILL.md",
      ),
    ).toThrow("PATH_UNSAFE");
  });

  it("rejects unsafe manifests, YAML features, invalid UTF-8, and oversized input", () => {
    expect(() =>
      parseClaudePluginManifest(
        bytes(
          JSON.stringify({
            name: "x",
            version: "1.0.0",
            description: "x",
            author: { name: "x" },
            license: "MIT",
            skills: ["./../outside"],
          }),
        ),
      ),
    ).toThrow("PATH_UNSAFE");
    expect(() =>
      parseSkillDocument(
        bytes("---\nname: x\ndescription: &value unsafe\n---\nBody\n"),
      ),
    ).toThrow("SKILL_SCHEMA_INVALID");
    expect(() => parseSkillDocument(Uint8Array.from([0xff, 0xfe]))).toThrow();
    expect(() => parseSkillDocument(new Uint8Array(256 * 1024 + 1))).toThrow(
      "SKILL_OVERSIZED",
    );
  });

  it.each([
    ["malformed JSON", bytes("{")],
    [
      "unknown manifest field",
      bytes(
        JSON.stringify({
          name: "x",
          version: "1.0.0",
          description: "x",
          author: { name: "x" },
          license: "MIT",
          skills: ["./a"],
          hooks: ["install.sh"],
        }),
      ),
    ],
    [
      "normalization collision",
      bytes(
        JSON.stringify({
          name: "x",
          version: "1.0.0",
          description: "x",
          author: { name: "x" },
          license: "MIT",
          skills: ["./A", "./a"],
        }),
      ),
    ],
    ["invalid UTF-8", Uint8Array.from([0xff])],
    ["NUL", bytes('{"name":"x\u0000"}')],
  ])("rejects hostile manifest input: %s", (_label, source) => {
    expect(() => parseClaudePluginManifest(source)).toThrow();
  });

  it.each([
    ["anchor", "name: &name example\ndescription: Example."],
    [
      "alias",
      "name: example\ndescription: &value Example.\nargument-hint: *value",
    ],
    ["tag", "name: example\ndescription: !unsafe Example."],
    ["duplicate", "name: example\nname: duplicate\ndescription: Example."],
    ["merge", "name: example\ndescription: Example.\n<<: {}"],
    [
      "excessive nesting",
      `name: example\ndescription: Example.\ndependencies:\n${"  - ".repeat(40)}nested`,
    ],
    [
      "oversized scalar",
      `name: example\ndescription: ${"a".repeat(17 * 1024)}`,
    ],
    [
      "unknown field",
      "name: example\ndescription: Example.\nhooks: install.sh",
    ],
  ])("rejects hostile YAML structure: %s", (_label, yaml) => {
    expect(() =>
      parseSkillDocument(bytes(`---\n${yaml}\n---\nBody\n`)),
    ).toThrow("SKILL_SCHEMA_INVALID");
  });

  it.each([
    ["invalid UTF-8", Uint8Array.from([0xff])],
    [
      "NUL",
      bytes("---\nname: example\ndescription: Example.\n---\nBody\u0000"),
    ],
    [
      "binary control",
      bytes("---\nname: example\ndescription: Example.\n---\nBody\u0001"),
    ],
    [
      "non-normalized Unicode",
      bytes("---\nname: example\ndescription: Example.\n---\ncafe\u0301"),
    ],
  ])("rejects non-text skill content: %s", (_label, source) => {
    expect(() => parseSkillDocument(source)).toThrow();
  });
});
