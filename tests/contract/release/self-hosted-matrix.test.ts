import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

describe("Feature 004 certified release matrix", () => {
  it("binds every OS/architecture/root-mode cell to a blocking pre-sign job", async () => {
    const workflowSource = await readFile(
      ".github/workflows/self-hosted-release.yml",
      "utf8",
    );
    const workflow = parseYaml(workflowSource) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    const matrixJob = workflow.jobs["certified-matrix"];
    if (matrixJob === undefined)
      throw new Error("Certified matrix job is missing");
    const strategy = matrixJob["strategy"] as {
      matrix: Record<string, string[]>;
    };
    expect(strategy.matrix).toEqual({
      os: ["ubuntu-24.04", "debian-12", "debian-13"],
      arch: ["amd64", "arm64"],
      "docker-mode": ["rootful", "rootless"],
    });
    const operatingSystems = strategy.matrix["os"];
    const architectures = strategy.matrix["arch"];
    const dockerModes = strategy.matrix["docker-mode"];
    if (
      operatingSystems === undefined ||
      architectures === undefined ||
      dockerModes === undefined
    ) {
      throw new Error("Certified matrix axes are incomplete");
    }
    expect(
      operatingSystems.length * architectures.length * dockerModes.length,
    ).toBe(12);
    expect(workflow.jobs["build-test-sign"]?.["needs"]).toBe(
      "certified-matrix",
    );
    expect(matrixJob["env"]).toMatchObject({
      SKILLWIRE_RUN_COMPOSE_INTEGRATION: "1",
      SKILLWIRE_RUN_SECRET_SERVICE_INTEGRATION: "1",
      SKILLWIRE_RUN_POSTGRES_BACKUP_INTEGRATION: "1",
    });
    const serialized = JSON.stringify(matrixJob);
    expect(serialized).toContain("gnome-keyring-daemon");
    expect(serialized).toContain("secret-tool");
    expect(serialized).toContain("codex --version");
    expect(serialized).toContain("claude --version");
    expect(workflowSource).toContain('test "${docker_version}" = "29.7.2"');
    expect(workflowSource).toContain('test "${compose_version}" = "5.4.0"');
  });

  it("keeps the distribution matrix and workflow claims exact", async () => {
    const matrix = JSON.parse(
      await readFile("distribution/self-hosted/supported-matrix.json", "utf8"),
    ) as {
      operatingSystems: unknown[];
      architectures: unknown[];
      dockerModes: unknown[];
      certification: {
        cellCount: number;
        observationsPerCell: string;
        releaseIdentity: string;
        failedOrIncomplete: string;
      };
      docker: { minimum: string; tested: string };
      compose: { minimum: string; tested: string };
      node: string;
      codex: string;
      claude: string;
      cosign: string;
    };
    expect(matrix).toMatchObject({
      operatingSystems: [
        { id: "ubuntu", version: "24.04" },
        { id: "debian", version: "12" },
        { id: "debian", version: "13" },
      ],
      architectures: ["amd64", "arm64"],
      dockerModes: ["rootful", "rootless"],
      certification: {
        cellCount: 12,
        observationsPerCell: "exactly-one",
        releaseIdentity: "same-final-tag-and-seven-assets",
        failedOrIncomplete: "not-certified-no-replacement-or-exclusion",
      },
      docker: { minimum: "29.7.2", tested: "29.7.2" },
      compose: { minimum: "5.4.0", tested: "5.4.0" },
      node: "24.18.0",
      codex: "0.147.0",
      claude: "2.1.229",
      cosign: "3.1.3",
    });
  });

  it("isolates every matrix cell and cleans only its exact Compose project", async () => {
    const workflowSource = await readFile(
      ".github/workflows/self-hosted-release.yml",
      "utf8",
    );
    expect(workflowSource).toContain("MATRIX_OS: ${{ matrix.os }}");
    expect(workflowSource).toContain("MATRIX_ARCH: ${{ matrix.arch }}");
    expect(workflowSource).toContain(
      "MATRIX_DOCKER_MODE: ${{ matrix.docker-mode }}",
    );
    expect(workflowSource).toContain(
      "${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${matrix_os}-${MATRIX_ARCH}-${MATRIX_DOCKER_MODE}",
    );
    expect(workflowSource).toContain(
      'docker compose --project-name "${SKILLWIRE_COMPOSE_PROJECT}"',
    );
    expect(workflowSource).toContain("down --volumes");
    expect(workflowSource).not.toContain("down --volumes --remove-orphans");
    expect(workflowSource).not.toContain("comm -13");
    expect(workflowSource).not.toContain("docker rm --force");
    expect(workflowSource).not.toContain("docker volume rm --force");
    expect(workflowSource).not.toContain("docker image rm --force");
    expect(workflowSource).not.toContain("docker network rm --");
  });

  it("keeps signed assets behind a post-sign certified-matrix gate", async () => {
    const workflowSource = await readFile(
      ".github/workflows/self-hosted-release.yml",
      "utf8",
    );
    const workflow = parseYaml(workflowSource) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    const signedMatrix = workflow.jobs["signed-asset-matrix"];
    expect(signedMatrix?.["needs"]).toBe("build-test-sign");
    const serializedSignedMatrix = JSON.stringify(signedMatrix);
    expect(serializedSignedMatrix).toContain(
      "validate-self-hosted-quickstart.ts",
    );
    expect(serializedSignedMatrix).toContain("download-artifact");
    expect(signedMatrix?.["env"]).toMatchObject({
      MATRIX_OS: "${{ matrix.os }}",
      MATRIX_ARCH: "${{ matrix.arch }}",
      MATRIX_DOCKER_MODE: "${{ matrix.docker-mode }}",
    });
    expect(serializedSignedMatrix).toContain(
      "Assert signed-asset runner identity",
    );
    expect(serializedSignedMatrix).toContain("DOCKER_HOST=${docker_host}");
    expect(serializedSignedMatrix).toContain("docker version --format");
    expect(serializedSignedMatrix).toContain("docker compose version --short");
    expect(serializedSignedMatrix).toContain("SecurityOptions");
    expect(workflow.jobs["publish"]?.["needs"]).toEqual([
      "build-test-sign",
      "signed-asset-matrix",
    ]);
    expect(workflowSource).toContain("expected-release-assets.txt");
    expect(workflowSource).toContain("actual-release-assets.txt");
  });

  it("pins every action and exposes no privileged pull-request release event", async () => {
    const workflowSource = await readFile(
      ".github/workflows/self-hosted-release.yml",
      "utf8",
    );
    const uses = [...workflowSource.matchAll(/^\s*- uses:\s+(\S+)/gmu)].map(
      (match) => match[1] ?? "",
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((use) => /@[0-9a-f]{40}$/.test(use))).toBe(true);
    expect(workflowSource).not.toMatch(/^\s+pull_request(?:_target)?:/mu);
    expect(workflowSource).not.toContain("pull-requests: write");
  });

  it("requires one non-replaceable observation per cell against one final seven-asset release", async () => {
    const evidenceContract = await readFile(
      "docs/self-hosted-release-evidence.md",
      "utf8",
    );
    expect(evidenceContract).toMatch(
      /exactly one observation for each of the 12 Cartesian\s+cells/,
    );
    expect(evidenceContract).toMatch(
      /same final\s+`self-hosted-v<package\.version>` annotated tag/,
    );
    expect(evidenceContract).toMatch(/exact seven\s+published assets/);
    expect(evidenceContract).toContain(
      "cannot be replaced, rerun as a substitute",
    );
    expect(evidenceContract).toMatch(
      /No cell is claimed as passed by this\s+preparation patch/,
    );
  });
});
