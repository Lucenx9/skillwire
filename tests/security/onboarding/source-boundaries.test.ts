import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitHubTokenCredentialStore } from "../../../src/onboarding/adapters/credentials/github-token.js";
import { readBoundedGitHubToken } from "../../../src/onboarding/adapters/credentials/github-token.js";
import { bootstrapSources } from "../../../src/onboarding/application/source-bootstrap.js";
import { bootstrapSourceInAdminContainer } from "../../../src/onboarding/application/source-bootstrap.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

describe("source bootstrap boundaries", () => {
  let fixture: OnboardingEnvironment | undefined;
  afterEach(async () => {
    await fixture?.close();
  });

  it("keeps imported text inert and performs zero client or repository writes", async () => {
    fixture = await createOnboardingEnvironment();
    const repository = resolve(fixture.root, "repository");
    const codex = resolve(fixture.home, ".codex");
    const claude = resolve(fixture.home, ".claude");
    await Promise.all([
      mkdir(repository, { recursive: true }),
      mkdir(codex, { recursive: true }),
      mkdir(claude, { recursive: true }),
    ]);
    const canary = resolve(fixture.root, "executed");
    const hostile = `#!/bin/sh\nprintf owned > ${canary}\n`;
    const before = await Promise.all([
      readFile(resolve(fixture.home, ".codex/config.toml")).catch(() => null),
      readFile(resolve(fixture.home, ".claude.json")).catch(() => null),
    ]);
    await bootstrapSources(
      [
        {
          source: "mattpocock/skills",
          credentialReferenceId: randomUUID(),
        },
      ],
      {
        listRegistrations: () => Promise.resolve([]),
        register: () =>
          Promise.resolve({ sourceId: randomUUID(), created: true }),
        synchronize: (sourceId) =>
          Promise.resolve({
            sourceId,
            classifications: ["quarantined"],
            created: true,
            evidence: { inertTextSha256: hostile.length.toString(16) },
          }),
      },
    );
    await expect(readFile(canary)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await Promise.all([
        readFile(resolve(fixture.home, ".codex/config.toml")).catch(() => null),
        readFile(resolve(fixture.home, ".claude.json")).catch(() => null),
      ]),
    ).toEqual(before);
    await expect(
      readFile(resolve(repository, "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores a GitHub token under a source-only Secret Service identity", async () => {
    fixture = await createOnboardingEnvironment();
    const binRoot = resolve(fixture.root, "bin");
    await mkdir(binRoot, { mode: 0o700 });
    const executable = resolve(binRoot, "secret-tool");
    const argvLog = resolve(fixture.root, "argv.jsonl");
    const stdinLog = resolve(fixture.root, "stdin");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nconst fs=require('node:fs');\nfs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2))+'\\n');\nlet input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{ if(process.argv[2]==='store') fs.writeFileSync(${JSON.stringify(stdinLog)}, input,{mode:0o600}); if(process.argv[2]==='lookup') process.stdout.write(fs.readFileSync(${JSON.stringify(stdinLog)},'utf8')+'\\n'); });\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const store = new GitHubTokenCredentialStore(executable, {
      PATH: process.env["PATH"],
    });
    const token = "github_pat_source_only_read_token";
    const saved = await store.store(token, new AbortController().signal);
    expect(saved.reference).toMatch(/^secret-service:github:[0-9a-f-]{36}$/);
    expect(await store.lookup(saved.reference)).toBe(token);
    const argv = await readFile(argvLog, "utf8");
    expect(argv).not.toContain(token);
    expect(argv).toContain('"purpose","github-source-read-only"');
    expect(argv).not.toContain('"client"');
    expect(Object.values(process.env)).not.toContain(token);
  });

  it("rejects and clears a GitHub credential whose Secret Service readback differs", async () => {
    fixture = await createOnboardingEnvironment();
    const binRoot = resolve(fixture.root, "bin-mismatch");
    await mkdir(binRoot, { mode: 0o700 });
    const executable = resolve(binRoot, "secret-tool");
    const operations = resolve(fixture.root, "operations.jsonl");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nconst fs=require('node:fs'); const operation=process.argv[2]; fs.appendFileSync(${JSON.stringify(operations)}, JSON.stringify(process.argv.slice(2))+'\\n'); if(operation==='lookup') process.stdout.write('github_pat_different_readback_token\\n'); process.stdin.resume();\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const store = new GitHubTokenCredentialStore(executable, {
      PATH: process.env["PATH"],
    });
    const token = "github_pat_source_only_read_token";
    await expect(store.store(token)).rejects.toThrow(
      /persistence|verification/i,
    );
    const calls = await readFile(operations, "utf8");
    expect(calls).toContain('"store"');
    expect(calls).toContain('"lookup"');
    expect(calls).toContain('"clear"');
    expect(calls).not.toContain(token);
  });

  it("redacts a GitHub token reflected by a failing credential provider", async () => {
    fixture = await createOnboardingEnvironment();
    const binRoot = resolve(fixture.root, "bin-reflection");
    await mkdir(binRoot, { mode: 0o700 });
    const executable = resolve(binRoot, "secret-tool");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nlet input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{ process.stderr.write(input); process.exit(1); });\n",
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const store = new GitHubTokenCredentialStore(executable, {
      PATH: process.env["PATH"],
    });
    const token = "github_pat_source_only_read_token";
    let failure: unknown;
    try {
      await store.store(token);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").not.toContain(
      token,
    );
  });

  it("passes a source credential only on container stdin, never argv or environment", async () => {
    const token = "github_pat_source_only_read_token";
    let observed:
      | Parameters<
          NonNullable<
            Parameters<typeof bootstrapSourceInAdminContainer>[0]["run"]
          >
        >[0]
      | undefined;
    await bootstrapSourceInAdminContainer({
      source: "obra/superpowers",
      token,
      dockerExecutable: "/usr/bin/docker",
      composePath: "/release/compose.yaml",
      projectName: "skillwire-1234567890abcdef",
      databasePasswordFile: "/state/database-password",
      applicationPepperFile: "/state/application-pepper",
      runtimeSocketDirectory: "/runtime/skillwire",
      volumeName: "skillwire-1234567890abcdef_postgres_data",
      skillwireImage: `ghcr.io/lucenx9/skillwire@sha256:${"1".repeat(64)}`,
      postgresImage: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
      environment: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        GH_TOKEN: "ambient-must-not-propagate",
      },
      run: (options) => {
        observed = options;
        return Promise.resolve({
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            schemaVersion: "skillwire.source-bootstrap-result/v1",
            sourceId: randomUUID(),
            registrationCreated: true,
            snapshotCreated: true,
            classifications: ["quarantined"],
          }),
        });
      },
    });
    expect(observed?.stdin).toBe(token);
    expect(observed?.args.join(" ")).not.toContain(token);
    expect(JSON.stringify(observed?.environment)).not.toContain(token);
    expect(observed?.environment).toMatchObject({
      SKILLWIRE_COMPOSE_PROJECT: "skillwire-1234567890abcdef",
      SKILLWIRE_POSTGRES_VOLUME: "skillwire-1234567890abcdef_postgres_data",
      SKILLWIRE_IMAGE: `ghcr.io/lucenx9/skillwire@sha256:${"1".repeat(64)}`,
      SKILLWIRE_POSTGRES_IMAGE: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
      SKILLWIRE_APPLICATION_PEPPER_SECRET_FILE: "/state/application-pepper",
      SKILLWIRE_RUNTIME_SOCKET_DIRECTORY: "/runtime/skillwire",
    });
    expect(observed?.environment?.["GH_TOKEN"]).toBeUndefined();
    expect(observed?.args).toContain("obra");
    expect(observed?.args).toContain("superpowers");
  });

  it("cancels bounded source credential input without waiting for another byte", async () => {
    const controller = new AbortController();
    async function* delayedInput(): AsyncGenerator<string> {
      await new Promise((done) => setTimeout(done, 75));
      yield "github_pat_source_only_read_token";
    }
    const reading = readBoundedGitHubToken(delayedInput(), controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 5);
    await expect(reading).rejects.toThrow(/cancel/i);
  });
});
