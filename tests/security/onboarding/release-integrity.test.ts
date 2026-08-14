import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateArchiveListings,
  verifySelfHostedReleasePolicy,
} from "../../../scripts/verify-self-hosted-release.js";
import { verifyManifestPayload } from "../../../src/onboarding/adapters/filesystem/release-verifier.js";
import {
  RELEASE_PAYLOAD_FILES,
  releaseManifestFixture,
  releasePayloadMode,
} from "../../helpers/self-hosted-release-fixtures.js";

const RELEASE_BOUNDARY_EVIDENCE = [
  [
    "canonical manifest",
    "tests/security/onboarding/trust-policy-lifecycle.test.ts",
    /canonical manifests/,
  ],
  [
    "signature and claims",
    "tests/security/onboarding/trust-policy-lifecycle.test.ts",
    /exact claim policy/,
  ],
  [
    "transparency",
    "tests/security/onboarding/trust-policy-lifecycle.test.ts",
    /transparency entries/,
  ],
  [
    "overlap",
    "tests/security/onboarding/trust-policy-lifecycle.test.ts",
    /overlap policy/,
  ],
  [
    "revocation",
    "tests/security/onboarding/trust-policy-lifecycle.test.ts",
    /emergency deny sets/,
  ],
  [
    "downgrade",
    "tests/security/onboarding/upgrade-trust-downgrade.test.ts",
    /downgrade boundary/,
  ],
  [
    "mutable image",
    "tests/integration/onboarding/service-setup.test.ts",
    /mutable image tags/,
  ],
] as const;

interface MutableComposeFixture {
  readonly services: Record<
    "admin" | "migrate" | "postgres" | "skillwire",
    Record<string, unknown>
  >;
  readonly secrets: Record<string, unknown>;
}

describe("self-hosted release integrity policy", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("accepts the pinned package, safe Compose, catalog, advisory, and exact matrix", async () => {
    await expect(
      verifySelfHostedReleasePolicy(releaseManifestFixture(), process.cwd()),
    ).resolves.toMatchObject({
      feature003PackageSha256:
        "f4e2e1cca7b4c99d41d585d2816b44b4203297ad15809e3c1b87bedb8b6e805e",
      firstPartyRevisionCount: 10,
      matrix: { architectures: ["amd64", "arm64"] },
    });
  });

  it("rejects traversal, links, special files, and inconsistent archive listings", () => {
    expect(() => {
      validateArchiveListings("../escape\n", "- escape\n");
    }).toThrow();
    expect(() => {
      validateArchiveListings("safe\n", "l safe -> target\n");
    }).toThrow();
    expect(() => {
      validateArchiveListings("safe\n", "p safe\n");
    }).toThrow();
    expect(() => {
      validateArchiveListings("safe\nextra\n", "- safe\n");
    }).toThrow();
    expect(() => {
      validateArchiveListings("safe\n", "- other\n");
    }).toThrow();
    expect(() => {
      validateArchiveListings("safe\nsafe\n", "- safe\n- safe\n");
    }).toThrow();
    expect(() => {
      validateArchiveListings("safe/./entry\n", "- safe/./entry\n");
    }).toThrow();
  });

  it("rejects unsafe Compose and certified-matrix overclaims", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "skillwire-release-policy-"));
    roots.push(root);
    await cp("distribution", resolve(root, "distribution"), {
      recursive: true,
    });
    await cp("integrations", resolve(root, "integrations"), {
      recursive: true,
    });
    await cp("catalog", resolve(root, "catalog"), { recursive: true });
    await writeFile(
      resolve(root, "distribution/self-hosted/compose.yaml"),
      "services:\n  skillwire:\n    image: skillwire:latest\n    privileged: true\n",
    );
    await expect(
      verifySelfHostedReleasePolicy(releaseManifestFixture(), root),
    ).rejects.toThrow(/Compose|policy/i);

    await writeFile(
      resolve(root, "distribution/self-hosted/compose.yaml"),
      await readFile("distribution/self-hosted/compose.yaml"),
    );
    const matrixPath = resolve(
      root,
      "distribution/self-hosted/supported-matrix.json",
    );
    const matrix = JSON.parse(await readFile(matrixPath, "utf8")) as {
      operatingSystems: unknown[];
    };
    matrix.operatingSystems.push({ id: "ubuntu", version: "26.04" });
    await writeFile(matrixPath, JSON.stringify(matrix));
    await expect(
      verifySelfHostedReleasePolicy(releaseManifestFixture(), root),
    ).rejects.toThrow(/matrix/i);
  });

  it.each([
    [
      "a host bind mount",
      (compose: MutableComposeFixture) => {
        const volumes = compose.services.skillwire["volumes"];
        if (!Array.isArray(volumes))
          throw new Error("Fixture volumes are missing");
        volumes.push("/etc:/host:ro");
      },
    ],
    [
      "a host device",
      (compose: MutableComposeFixture) => {
        compose.services.skillwire["devices"] = ["/dev/kmsg:/dev/kmsg"];
      },
    ],
    [
      "host PID sharing",
      (compose: MutableComposeFixture) => {
        compose.services.skillwire["pid"] = "host";
      },
    ],
    [
      "an unrestricted capability",
      (compose: MutableComposeFixture) => {
        compose.services.skillwire["cap_add"] = ["ALL"];
      },
    ],
    [
      "a build directive",
      (compose: MutableComposeFixture) => {
        compose.services.skillwire["build"] = ".";
      },
    ],
    [
      "a mutable PostgreSQL image",
      (compose: MutableComposeFixture) => {
        compose.services.postgres["image"] = "postgres:latest";
      },
    ],
    [
      "an undeclared host-file secret",
      (compose: MutableComposeFixture) => {
        compose.secrets["host_key"] = {
          file: "/home/operator/.ssh/id_rsa",
        };
        const secrets = compose.services.skillwire["secrets"];
        if (!Array.isArray(secrets))
          throw new Error("Fixture secrets are missing");
        secrets.push({ source: "host_key", target: "host_key", mode: 0o400 });
      },
    ],
    [
      "an entrypoint override",
      (compose: MutableComposeFixture) => {
        compose.services.skillwire["entrypoint"] = ["/bin/sh", "-c"];
      },
    ],
    [
      "a command override",
      (compose: MutableComposeFixture) => {
        compose.services.skillwire["command"] = ["cat /run/secrets/host_key"];
      },
    ],
    [
      "a user override",
      (compose: MutableComposeFixture) => {
        compose.services.skillwire["user"] = "1000:1000";
      },
    ],
    [
      "an environment-file override",
      (compose: MutableComposeFixture) => {
        compose.services.skillwire["env_file"] = ["/tmp/attacker.env"];
      },
    ],
    [
      "an environment override",
      (compose: MutableComposeFixture) => {
        const environment = compose.services.skillwire["environment"];
        if (environment === null || typeof environment !== "object")
          throw new Error("Fixture environment is missing");
        (environment as Record<string, unknown>)["SKILLWIRE_BIND_HOST"] =
          "0.0.0.0";
      },
    ],
    [
      "a healthcheck override",
      (compose: MutableComposeFixture) => {
        compose.services.skillwire["healthcheck"] = {
          test: ["CMD-SHELL", "exit 0"],
        };
      },
    ],
    [
      "a dependency override",
      (compose: MutableComposeFixture) => {
        compose.services.skillwire["depends_on"] = {};
      },
    ],
    [
      "a writable temporary filesystem override",
      (compose: MutableComposeFixture) => {
        compose.services.skillwire["tmpfs"] = ["/tmp:rw,size=1g"];
      },
    ],
    [
      "a restart-policy override",
      (compose: MutableComposeFixture) => {
        compose.services.admin["restart"] = "always";
      },
    ],
    [
      "a logging override",
      (compose: MutableComposeFixture) => {
        compose.services.admin["logging"] = { driver: "json-file" };
      },
    ],
    [
      "a profile override",
      (compose: MutableComposeFixture) => {
        compose.services.admin["profiles"] = ["default"];
      },
    ],
  ] as const)("rejects production Compose with %s", async (_label, mutate) => {
    const root = await mkdtemp(resolve(tmpdir(), "skillwire-compose-policy-"));
    roots.push(root);
    await cp("distribution", resolve(root, "distribution"), {
      recursive: true,
    });
    await cp("integrations", resolve(root, "integrations"), {
      recursive: true,
    });
    await cp("catalog", resolve(root, "catalog"), { recursive: true });
    const composePath = resolve(root, "distribution/self-hosted/compose.yaml");
    const { parse, stringify } = await import("yaml");
    const compose = parse(
      await readFile(composePath, "utf8"),
    ) as unknown as MutableComposeFixture;
    mutate(compose);
    await writeFile(composePath, stringify(compose));

    await expect(
      verifySelfHostedReleasePolicy(releaseManifestFixture(), root),
    ).rejects.toThrow(/Compose|policy/i);
  });

  it("rejects unlisted payload bytes and unsafe filesystem entries", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "skillwire-release-payload-"));
    roots.push(root);
    for (const [path, contents] of Object.entries(RELEASE_PAYLOAD_FILES)) {
      const target = resolve(root, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, contents, { mode: releasePayloadMode(path) });
      await chmod(target, releasePayloadMode(path));
    }
    const manifest = releaseManifestFixture();
    await expect(
      verifyManifestPayload(manifest, root),
    ).resolves.toBeUndefined();
    await writeFile(resolve(root, "unlisted-byte"), "x", { mode: 0o600 });
    await expect(verifyManifestPayload(manifest, root)).rejects.toThrow(
      /undeclared|inventory/i,
    );
  });

  it("keeps every signed-release trust boundary in the executable aggregate", async () => {
    for (const [boundary, path, pattern] of RELEASE_BOUNDARY_EVIDENCE) {
      const suite = await readFile(path, "utf8");
      expect(suite, `${boundary}: ${path}`).toMatch(pattern);
      expect(suite, `${boundary}: ${path}`).toMatch(/\bit(?:\.each)?\(/);
    }
  });
});
