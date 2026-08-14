import {
  chmod,
  link,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";
import {
  atomicWriteJson,
  captureFileIdentity,
  identityStillMatches,
} from "../../../src/onboarding/adapters/filesystem/atomic-state.js";
import {
  openOwnedFileNoFollow,
  validateOwnedDirectory,
  validateOwnedPath,
} from "../../../src/onboarding/adapters/filesystem/safe-paths.js";

describe("safe onboarding filesystem", () => {
  let fixture: OnboardingEnvironment | undefined;

  afterEach(async () => fixture?.close());

  it("rejects traversal, links, loose modes, and opens files without following", async () => {
    fixture = await createOnboardingEnvironment();
    const root = resolve(fixture.root, "owned");
    await mkdir(root, { mode: 0o700 });
    await validateOwnedDirectory(root, fixture.root);
    await expect(
      validateOwnedPath(resolve(root, "../escape"), root),
    ).rejects.toThrow();
    const target = resolve(root, "target");
    await writeFile(target, "secret", { mode: 0o600 });
    await symlink(target, resolve(root, "link"));
    await expect(
      openOwnedFileNoFollow(resolve(root, "link"), root),
    ).rejects.toThrow();
    await chmod(target, 0o644);
    await expect(openOwnedFileNoFollow(target, root)).rejects.toThrow(/mode/i);
    await chmod(target, 0o600);
    await link(target, resolve(root, "hard-link"));
    await expect(openOwnedFileNoFollow(target, root)).rejects.toThrow(
      /single|link/i,
    );
    const linkedDirectory = resolve(fixture.root, "linked-directory");
    await mkdir(linkedDirectory, { mode: 0o700 });
    await symlink(linkedDirectory, resolve(root, "directory-link"));
    await expect(
      validateOwnedPath(resolve(root, "directory-link/record.json"), root),
    ).rejects.toThrow(/link/i);
  });

  it("uses exclusive staging, atomic replace, sync, and captures semantic identity", async () => {
    fixture = await createOnboardingEnvironment();
    const root = resolve(fixture.root, "state");
    await mkdir(root, { mode: 0o700 });
    const path = resolve(root, "record.json");
    await atomicWriteJson(path, { b: 2, a: 1 }, root);
    expect(await readFile(path, "utf8")).toBe('{"a":1,"b":2}\n');
    const first = await captureFileIdentity(path, root);
    await atomicWriteJson(path, { a: 1, b: 2 }, root);
    const second = await captureFileIdentity(path, root);
    expect(second.semanticSha256).toBe(first.semanticSha256);
    expect(second.mode).toBe(0o600);
    expect(await identityStillMatches(path, root, second)).toBe(true);
    await atomicWriteJson(path, { a: 2 }, root);
    expect(await identityStillMatches(path, root, second)).toBe(false);
    const outside = resolve(fixture.root, "outside.json");
    await writeFile(outside, "outside", { mode: 0o600 });
    const linked = resolve(root, "linked-record.json");
    await symlink(outside, linked);
    await expect(atomicWriteJson(linked, { safe: true }, root)).rejects.toThrow(
      /link|unsafe/i,
    );
    expect(await readFile(outside, "utf8")).toBe("outside");
  });
});
