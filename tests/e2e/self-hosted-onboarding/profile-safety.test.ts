import {
  chmod,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureProfileSnapshot,
  recordExpectedProfilePostImage,
  restoreProfileSnapshot,
} from "../../../src/onboarding/domain/profile-snapshot.js";
import {
  ProfileTransactionRecoveryError,
  runProfileTransaction,
} from "../../../src/onboarding/application/profile-transaction.js";
import { installClientLifecycle } from "../../../src/onboarding/application/client-lifecycle.js";
import {
  concurrentProfileEdit,
  createClientProfileFixture,
  snapshotTree,
  type ClientProfileFixture,
} from "../../helpers/client-profile-fixtures.js";

describe("profile snapshot and repository safety", () => {
  let fixture: ClientProfileFixture | undefined;
  afterEach(async () => fixture?.close());

  it("restores the exact pre-image only while the expected post-image still matches", async () => {
    fixture = await createClientProfileFixture();
    const before = await readFile(fixture.codexConfig, "utf8");
    let snapshot = await captureProfileSnapshot({
      client: "codex",
      profileRoot: fixture.home,
      stateRoot: fixture.xdgStateHome,
      relativePaths: [".codex/config.toml"],
    });
    await writeFile(fixture.codexConfig, `${before}\n# owned mutation\n`, {
      mode: 0o600,
    });
    snapshot = await recordExpectedProfilePostImage(snapshot);
    expect(await restoreProfileSnapshot(snapshot)).toMatchObject({
      restorationState: "restored",
    });
    expect(await readFile(fixture.codexConfig, "utf8")).toBe(before);
  });

  it("refuses stale restore after an unrelated concurrent edit", async () => {
    fixture = await createClientProfileFixture();
    const before = await readFile(fixture.claudeConfig, "utf8");
    let snapshot = await captureProfileSnapshot({
      client: "claude",
      profileRoot: fixture.home,
      stateRoot: fixture.xdgStateHome,
      relativePaths: [".claude.json"],
    });
    await writeFile(fixture.claudeConfig, `${before.trim()}\n`, {
      mode: 0o600,
    });
    snapshot = await recordExpectedProfilePostImage(snapshot);
    await writeFile(fixture.claudeConfig, concurrentProfileEdit(before), {
      mode: 0o600,
    });

    expect(await restoreProfileSnapshot(snapshot)).toMatchObject({
      restorationState: "blocked-by-concurrent-change",
    });
    expect(await readFile(fixture.claudeConfig, "utf8")).toContain(
      "concurrent fixture",
    );
  });

  it("never captures or writes the active repository", async () => {
    fixture = await createClientProfileFixture();
    const repositoryBefore = await snapshotTree(fixture.repository);
    await expect(
      captureProfileSnapshot({
        client: "codex",
        profileRoot: fixture.home,
        stateRoot: fixture.xdgStateHome,
        relativePaths: [resolve(fixture.repository, ".codex/config.toml")],
      }),
    ).rejects.toThrow(/relative|profile|outside/i);
    expect(await snapshotTree(fixture.repository)).toEqual(repositoryBefore);
  });

  it("rejects symlinked profile and snapshot ancestors before copying bytes", async () => {
    fixture = await createClientProfileFixture();
    const outside = resolve(fixture.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, resolve(fixture.home, "linked-profile"));
    await expect(
      captureProfileSnapshot({
        client: "claude",
        profileRoot: fixture.home,
        stateRoot: fixture.xdgStateHome,
        relativePaths: ["linked-profile/config.json"],
      }),
    ).rejects.toThrow(/symlink|unsafe/i);

    await mkdir(resolve(fixture.xdgStateHome, "skillwire"), { mode: 0o700 });
    await symlink(
      outside,
      resolve(fixture.xdgStateHome, "skillwire/snapshots"),
    );
    await expect(
      captureProfileSnapshot({
        client: "codex",
        profileRoot: fixture.home,
        stateRoot: fixture.xdgStateHome,
        relativePaths: [".codex/config.toml"],
      }),
    ).rejects.toThrow(/unsafe|symlink/i);
  });

  it("uses the narrow inverse after failed verification when it restores the exact pre-image", async () => {
    fixture = await createClientProfileFixture();
    const before = await readFile(fixture.codexConfig, "utf8");
    await expect(
      runProfileTransaction({
        snapshot: {
          client: "codex",
          profileRoot: fixture.home,
          stateRoot: fixture.xdgStateHome,
          relativePaths: [".codex/config.toml"],
        },
        mutate: async () => {
          await writeFile(fixture?.codexConfig ?? "", `${before}# owned\n`, {
            mode: 0o600,
          });
          return "mutated";
        },
        verify: () => Promise.reject(new Error("readback failed")),
        inverse: () =>
          writeFile(fixture?.codexConfig ?? "", before, { mode: 0o600 }),
      }),
    ).rejects.toThrow(/readback failed/);
    expect(await readFile(fixture.codexConfig, "utf8")).toBe(before);
  });

  it("retains a concurrent edit and reports recovery instead of restoring stale bytes", async () => {
    fixture = await createClientProfileFixture();
    const before = await readFile(fixture.claudeConfig, "utf8");
    await expect(
      runProfileTransaction({
        snapshot: {
          client: "claude",
          profileRoot: fixture.home,
          stateRoot: fixture.xdgStateHome,
          relativePaths: [".claude.json"],
        },
        mutate: async () => {
          await writeFile(fixture?.claudeConfig ?? "", `${before.trim()}\n`, {
            mode: 0o600,
          });
          return "mutated";
        },
        verify: async () => {
          await writeFile(
            fixture?.claudeConfig ?? "",
            `${before.trim()}\n/* concurrent during verification */\n`,
            { mode: 0o600 },
          );
          throw new Error("readback failed");
        },
        inverse: () => Promise.reject(new Error("unsafe inverse")),
      }),
    ).rejects.toBeInstanceOf(ProfileTransactionRecoveryError);
    expect(await readFile(fixture.claudeConfig, "utf8")).toContain(
      "concurrent during verification",
    );
  });

  it("uses exact per-effect checkpoints for an uncontended client rollback", async () => {
    fixture = await createClientProfileFixture();
    const before = await readFile(fixture.claudeConfig);
    const mcpPost = Buffer.from(
      `${JSON.stringify({
        ...JSON.parse(before.toString("utf8")),
        skillwireMcpFixture: true,
      })}\n`,
    );
    const pluginPost = Buffer.from(
      `${JSON.stringify({
        ...JSON.parse(mcpPost.toString("utf8")),
        skillwirePluginFixture: true,
      })}\n`,
    );
    const inverses: string[] = [];

    const result = await installClientLifecycle("claude", {
      preflight: () => Promise.resolve(),
      provisionCredential: () =>
        Promise.resolve({ keyId: "fixture", reference: "fixture" }),
      addMcp: () => writeFile(fixture?.claudeConfig ?? "", mcpPost),
      addPlugin: () => writeFile(fixture?.claudeConfig ?? "", pluginPost),
      verify: () => Promise.reject(new Error("readback failure")),
      removePlugin: async () => {
        inverses.push("plugin");
        await writeFile(fixture?.claudeConfig ?? "", mcpPost);
      },
      removeMcp: async () => {
        inverses.push("mcp");
        await writeFile(fixture?.claudeConfig ?? "", before);
      },
      revokeCredential: () => Promise.resolve(),
      profileSnapshot: {
        client: "claude",
        profileRoot: fixture.home,
        stateRoot: fixture.xdgStateHome,
        relativePaths: [".claude.json"],
      },
    });

    expect(result).toMatchObject({ status: "failed", compensated: true });
    expect(inverses).toEqual(["plugin", "mcp"]);
    expect(await readFile(fixture.claudeConfig)).toEqual(before);
  });

  it.each(["field", "inode", "mode"] as const)(
    "refuses client inverses after a concurrent %s change",
    async (change) => {
      fixture = await createClientProfileFixture();
      const before = await readFile(fixture.claudeConfig);
      const owned = Buffer.from(
        `${JSON.stringify({
          ...JSON.parse(before.toString("utf8")),
          skillwireFixture: true,
        })}\n`,
      );
      const removeMcp = vi.fn(() => Promise.resolve());
      const removePlugin = vi.fn(() => Promise.resolve());
      const result = await installClientLifecycle("claude", {
        preflight: () => Promise.resolve(),
        provisionCredential: () =>
          Promise.resolve({ keyId: "fixture", reference: "fixture" }),
        addMcp: () => writeFile(fixture?.claudeConfig ?? "", owned),
        addPlugin: () => Promise.resolve(),
        verify: async () => {
          const path = fixture?.claudeConfig ?? "";
          if (change === "field") {
            await writeFile(
              path,
              `${JSON.stringify({
                ...JSON.parse(owned.toString("utf8")),
                concurrentFixture: true,
              })}\n`,
            );
          } else if (change === "inode") {
            const replacement = `${path}.replacement`;
            await writeFile(replacement, owned, { mode: 0o600 });
            await rename(replacement, path);
          } else {
            await chmod(path, 0o640);
          }
          throw new Error("readback failure");
        },
        removePlugin,
        removeMcp,
        revokeCredential: () => Promise.resolve(),
        profileSnapshot: {
          client: "claude",
          profileRoot: fixture.home,
          stateRoot: fixture.xdgStateHome,
          relativePaths: [".claude.json"],
        },
      });

      expect(result).toMatchObject({
        status: "recovery-required",
        compensated: false,
      });
      expect(removePlugin).not.toHaveBeenCalled();
      expect(removeMcp).not.toHaveBeenCalled();
      if (change === "field")
        expect(await readFile(fixture.claudeConfig, "utf8")).toContain(
          "concurrentFixture",
        );
    },
  );
});
