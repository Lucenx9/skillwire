import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export interface OnboardingEnvironment {
  readonly root: string;
  readonly home: string;
  readonly xdgConfigHome: string;
  readonly xdgDataHome: string;
  readonly xdgStateHome: string;
  readonly xdgCacheHome: string;
  readonly runtimeRoot: string;
  readonly repository: string;
  readonly stateRoot: string;
  readonly composeProject: string;
  readonly postgresVolume: string;
  readonly environment: NodeJS.ProcessEnv;
  assertMutablePath(path: string): void;
  close(): Promise<void>;
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function createOnboardingEnvironment(): Promise<OnboardingEnvironment> {
  const root = await mkdtemp(resolve(tmpdir(), "skillwire-onboarding-"));
  const home = resolve(root, "home");
  const xdgConfigHome = resolve(root, "xdg/config");
  const xdgDataHome = resolve(root, "xdg/data");
  const xdgStateHome = resolve(root, "xdg/state");
  const xdgCacheHome = resolve(root, "xdg/cache");
  const runtimeRoot = resolve(root, "xdg/runtime");
  const repository = resolve(root, "empty-repository");
  const stateRoot = resolve(xdgDataHome, "skillwire");
  await Promise.all(
    [
      home,
      xdgConfigHome,
      xdgDataHome,
      xdgStateHome,
      xdgCacheHome,
      runtimeRoot,
      repository,
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );

  const canonicalRoot = await realpath(root);
  const realHome = process.env["HOME"];
  const realRepository = process.cwd();
  const suffix = randomBytes(8).toString("hex");
  const composeProject = `skillwire-test-${suffix}`;

  function assertMutablePath(path: string): void {
    if (!isAbsolute(path)) throw new Error("Mutation target must be absolute");
    const target = resolve(path);
    if (!isContained(canonicalRoot, target)) {
      throw new Error("Mutation target escapes the disposable environment");
    }
    if (
      (realHome !== undefined && isContained(resolve(realHome), target)) ||
      isContained(resolve(realRepository), target)
    ) {
      throw new Error(
        "Mutation target resolves to a real profile or workspace",
      );
    }
  }

  return {
    root: canonicalRoot,
    home,
    xdgConfigHome,
    xdgDataHome,
    xdgStateHome,
    xdgCacheHome,
    runtimeRoot,
    repository,
    stateRoot,
    composeProject,
    postgresVolume: `${composeProject}_postgres_data`,
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_STATE_HOME: xdgStateHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_RUNTIME_DIR: runtimeRoot,
      PATH: process.env["PATH"],
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    assertMutablePath,
    close: async () => {
      assertMutablePath(canonicalRoot);
      await rm(canonicalRoot, { recursive: true, force: true });
    },
  };
}
