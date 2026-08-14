import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "./onboarding-environment.js";
import type { ClientComponentObservation } from "../../src/onboarding/adapters/clients/client-state.js";

export const PROFILE_CANARY = "profile-canary-must-remain-private";
export const EXPECTED_CLIENT_COMPONENT_IDENTITY = "a".repeat(64);

export const CLIENT_COMPONENT_OBSERVATION_FIXTURES: Readonly<
  Record<
    "managed" | "duplicate" | "shadowed" | "conflict" | "alternate-name",
    readonly ClientComponentObservation[]
  >
> = {
  managed: [
    {
      name: "skillwire",
      scope: "managed",
      effective: true,
      managed: true,
      identitySha256: "c".repeat(64),
    },
  ],
  duplicate: [
    {
      name: "skillwire",
      scope: "user",
      effective: true,
      managed: false,
      identitySha256: EXPECTED_CLIENT_COMPONENT_IDENTITY,
    },
    {
      name: "skillwire",
      scope: "project",
      effective: true,
      managed: false,
      identitySha256: "b".repeat(64),
    },
  ],
  shadowed: [
    {
      name: "skillwire",
      scope: "user",
      effective: false,
      managed: false,
      identitySha256: EXPECTED_CLIENT_COMPONENT_IDENTITY,
    },
    {
      name: "skillwire",
      scope: "project",
      effective: true,
      managed: false,
      identitySha256: "b".repeat(64),
    },
  ],
  conflict: [
    {
      name: "skillwire",
      scope: "user",
      effective: true,
      managed: false,
      identitySha256: "b".repeat(64),
    },
  ],
  "alternate-name": [
    {
      name: "alternate_skillwire",
      scope: "user",
      effective: true,
      managed: false,
      identitySha256: EXPECTED_CLIENT_COMPONENT_IDENTITY,
    },
  ],
};

export function concurrentProfileEdit(before: string): string {
  return `${before.trim()}\n/* concurrent fixture */\n`;
}

export interface ClientProfileFixture extends OnboardingEnvironment {
  readonly launcher: string;
  readonly codexConfig: string;
  readonly claudeConfig: string;
  readonly claudeSettings: string;
  readonly repositoryCanary: string;
}

export interface TreeSnapshot {
  readonly sha256: string;
  readonly files: Readonly<Record<string, string>>;
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
    else throw new Error("fixture tree contains a non-regular entry");
  }
  return files;
}

export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const files: Record<string, string> = {};
  for (const path of await walk(root)) {
    const bytes = await readFile(resolve(root, path));
    files[path] = createHash("sha256").update(bytes).digest("hex");
  }
  return {
    files,
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

export async function createClientProfileFixture(): Promise<ClientProfileFixture> {
  const environment = await createOnboardingEnvironment();
  const codexRoot = resolve(environment.home, ".codex");
  const claudeRoot = resolve(environment.home, ".claude");
  const launcherRoot = resolve(environment.root, "owned/bin");
  const launcher = resolve(launcherRoot, "skillwire");
  const codexConfig = resolve(codexRoot, "config.toml");
  const claudeConfig = resolve(environment.home, ".claude.json");
  const claudeSettings = resolve(claudeRoot, "settings.json");
  const repositoryCanary = resolve(
    environment.repository,
    "existing-project-file.txt",
  );
  await Promise.all(
    [codexRoot, claudeRoot, launcherRoot].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  await writeFile(launcher, "#!/bin/sh\n# disposable launcher\nexit 0\n", {
    mode: 0o700,
  });
  await chmod(launcher, 0o700);
  await writeFile(
    codexConfig,
    [
      "# unrelated comment must survive the certified manager",
      'model = "fixture-model"',
      'model_reasoning_effort = "high"',
      'future_profile_field = "preserved"',
      "",
      "[mcp_servers.unrelated]",
      'command = "/bin/true"',
      'args = ["--unrelated"]',
      "",
      "[mcp_servers.disabled_fixture]",
      'command = "/bin/false"',
      "enabled = false",
      "",
      "[mcp_servers.remote_fixture]",
      'url = "http://127.0.0.1:1/mcp"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(
    claudeConfig,
    `${JSON.stringify(
      {
        hasCompletedOnboarding: true,
        authFixture: PROFILE_CANARY,
        futureProfileField: { nested: ["preserved", 7] },
        mcpServers: {
          unrelated: {
            type: "stdio",
            command: "/bin/true",
            args: ["--unrelated"],
            env: {},
          },
          disabled_fixture: {
            type: "stdio",
            command: "/bin/false",
            args: [],
            env: {},
            disabled: true,
          },
          remote_fixture: {
            type: "http",
            url: "http://127.0.0.1:1/mcp",
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    claudeSettings,
    `${JSON.stringify(
      {
        model: "fixture-model",
        permissions: { allow: ["Read"], deny: ["WebFetch"] },
        hooks: {
          Stop: [
            {
              matcher: "fixture",
              hooks: [{ type: "command", command: "/bin/true" }],
            },
          ],
        },
        enabledPlugins: { "unrelated@fixture": true },
        futureSettingsField: { preserved: true },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(repositoryCanary, "repository-canary\n", { mode: 0o600 });
  await stat(repositoryCanary);
  return {
    ...environment,
    launcher,
    codexConfig,
    claudeConfig,
    claudeSettings,
    repositoryCanary,
  };
}

export function semanticJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
