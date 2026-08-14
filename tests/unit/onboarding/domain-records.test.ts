import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BackupRecordSchema,
  ClientIntegrationSchema,
  CredentialReferenceSchema,
  InstallationSchema,
  ProfileSnapshotSchema,
  ServiceSecretSetSchema,
  SourceChoiceSchema,
  VerificationRecordSchema,
  transitionClientIntegration,
  transitionInstallation,
} from "../../../src/onboarding/domain/installation.js";
import {
  ExternalIntegrationDependencySchema,
  OwnershipRecordSchema,
  classifyExternalDependency,
} from "../../../src/onboarding/domain/ownership.js";
import { DiagnosticFindingSchema } from "../../../src/onboarding/domain/diagnostics.js";
import { InstalledReleaseSchema } from "../../../src/onboarding/domain/release-manifest.js";
import { OperationRecordSchema } from "../../../src/onboarding/domain/operation-journal.js";

const installationId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const now = "2026-08-13T00:00:00.000Z";
const sha = "a".repeat(64);

describe("onboarding records and transitions", () => {
  it("validates installation, installed-release, service-secret, and client state machines", () => {
    const installation = InstallationSchema.parse({
      schemaVersion: "skillwire.installation/v1",
      installationId,
      ownerUid: process.getuid?.() ?? 0,
      accountId: randomUUID(),
      activeReleaseId: "1-amd64",
      highestAcceptedReleaseSequence: 1,
      activeTrustPolicySequence: 1,
      endpoint: "unix:///tmp/disposable/mcp.sock",
      composeProject: "skillwire-0000000000004000",
      postgresVolume: "skillwire-0000000000004000_postgres_data",
      selectedClients: ["codex"],
      clientIntegrationIds: { codex: randomUUID(), claude: null },
      status: "prepared",
      createdAt: now,
      updatedAt: now,
      lastValidatedAt: null,
    });
    expect(transitionInstallation(installation, "service-ready").status).toBe(
      "service-ready",
    );
    expect(() => transitionInstallation(installation, "complete")).toThrow();

    const installed = InstalledReleaseSchema.parse({
      schemaVersion: "skillwire.installed-release/v1",
      releaseVersion: "0.1.0",
      releaseSequence: 1,
      manifestSha256: sha,
      archiveSha256: "b".repeat(64),
      trustPolicySequence: 1,
      installedPath: "releases/1-amd64",
      installedAt: now,
    });
    expect(installed.releaseSequence).toBe(1);

    const secretSet = ServiceSecretSetSchema.parse({
      schemaVersion: "skillwire.service-secret-set/v1",
      serviceSecretSetId: randomUUID(),
      installationId,
      state: "available",
      createdByOperation: operationId,
      secrets: [
        {
          kind: "database-password",
          relativePath: "secrets/database-password",
          identitySha256: sha,
          state: "reused",
        },
        {
          kind: "application-pepper",
          relativePath: "secrets/application-pepper",
          identitySha256: "b".repeat(64),
          state: "created",
        },
      ],
    });
    expect(secretSet.secrets).toHaveLength(2);

    const client = ClientIntegrationSchema.parse({
      schemaVersion: "skillwire.client-integration/v1",
      clientIntegrationId: randomUUID(),
      installationId,
      client: "codex",
      clientVersion: "0.147.0",
      profileScope: "normal-user",
      state: "planned",
      credentialReferenceId: null,
      keyPublicIdHash: null,
      mcpIdentitySha256: sha,
      adapterIdentitySha256: "b".repeat(64),
    });
    expect(transitionClientIntegration(client, "credential-stored").state).toBe(
      "credential-stored",
    );
    expect(() => transitionClientIntegration(client, "verified")).toThrow();
  });

  it("validates owned and external dependencies without converting equivalence into ownership", () => {
    const external = ExternalIntegrationDependencySchema.parse({
      schemaVersion: "skillwire.external-integration/v1",
      externalDependencyId: randomUUID(),
      client: "claude",
      kind: "mcp-entry",
      scope: "user",
      observedIdentitySha256: sha,
      verification: "equivalent",
      lastObservedAt: now,
    });
    const record = OwnershipRecordSchema.parse({
      schemaVersion: "skillwire.ownership/v1",
      installationId,
      recordRevision: 1,
      assets: [
        {
          assetId: randomUUID(),
          kind: "release",
          locator: "releases/1-amd64",
          expectedIdentitySha256: sha,
          createdByOperation: operationId,
          retention: "retain-by-default",
          disposition: "present",
          client: null,
        },
      ],
      externalDependencies: [external.externalDependencyId],
      recordSha256: "b".repeat(64),
    });
    expect(record.assets).toHaveLength(1);
    expect(classifyExternalDependency(true, true)).toBe("external-equivalent");
    expect(classifyExternalDependency(true, false)).toBe("same-name-conflict");
  });

  it("validates credential, snapshot, journal, backup, verification, finding, and source-choice records", () => {
    expect(
      CredentialReferenceSchema.parse({
        schemaVersion: "skillwire.credential-reference/v1",
        credentialReferenceId: randomUUID(),
        installationId,
        client: "codex",
        backend: "restrictive-file",
        locator: "credentials/00000000-0000-4000-8000-000000000001/codex.key",
        keyPublicIdHash: sha,
        createdByOperation: operationId,
        state: "available",
        fallbackRiskConfirmed: true,
      }).backend,
    ).toBe("restrictive-file");
    expect(
      ProfileSnapshotSchema.parse({
        schemaVersion: "skillwire.profile-snapshot/v1",
        snapshotId: randomUUID(),
        client: "codex",
        scope: "normal-user",
        capturedPaths: [".codex/config.toml"],
        beforeIdentitySha256: sha,
        expectedPostIdentitySha256: null,
        protectedCopy: "snapshots/codex.bin",
        restorationState: "eligible",
      }).restorationState,
    ).toBe("eligible");
    expect(
      OperationRecordSchema.parse({
        schemaVersion: "skillwire.operation/v1",
        operationId,
        installationId,
        command: "setup",
        previewHash: sha,
        state: "running",
        rollbackBoundary: "client-only",
        createdAt: now,
        updatedAt: now,
      }).state,
    ).toBe("running");
    expect(
      BackupRecordSchema.parse({
        schemaVersion: "skillwire.backup/v1",
        backupId: randomUUID(),
        installationId,
        status: "validated",
        createdAt: now,
        archiveSha256: sha,
        sourceReleaseId: "1-amd64",
        serviceSecretReferences: [],
        clientCredentialReferences: [],
      }).status,
    ).toBe("validated");
    expect(
      VerificationRecordSchema.parse({
        schemaVersion: "skillwire.verification/v1",
        verificationId: randomUUID(),
        installationId,
        client: "claude",
        clientVersion: "2.1.229",
        verifiedAt: now,
        tools: [
          "search_skills",
          "load_skill",
          "read_skill_resource",
          "list_repo_memory",
          "record_skill_outcome",
          "forget_repo_memory",
        ],
        contractSha256: sha,
        provenanceCheck: true,
        advisoryCheck: true,
        result: "passed",
      }).result,
    ).toBe("passed");
    expect(
      DiagnosticFindingSchema.parse({
        code: "CLIENT_NOT_INSTALLED",
        severity: "warning",
        component: "codex",
        summary: "Codex is not installed",
        nextAction: "Install the certified client version",
        evidence: { version: "absent" },
      }).code,
    ).toBe("CLIENT_NOT_INSTALLED");
    expect(
      SourceChoiceSchema.parse({
        schemaVersion: "skillwire.source-choice/v1",
        sourceChoiceId: randomUUID(),
        source: "mattpocock/skills",
        selected: false,
        credentialReferenceId: null,
        registrationIdentity: null,
        syncState: "not-selected",
      }).selected,
    ).toBe(false);
  });

  it("rejects duplicate client selections, duplicate secret kinds, and secret-like diagnostic evidence", () => {
    const base = {
      schemaVersion: "skillwire.service-secret-set/v1",
      serviceSecretSetId: randomUUID(),
      installationId,
      state: "available",
      createdByOperation: operationId,
      secrets: [
        {
          kind: "database-password",
          relativePath: "secrets/database-password",
          identitySha256: sha,
          state: "created",
        },
        {
          kind: "database-password",
          relativePath: "secrets/database-password",
          identitySha256: "b".repeat(64),
          state: "created",
        },
      ],
    };
    expect(() => ServiceSecretSetSchema.parse(base)).toThrow();
    expect(() =>
      DiagnosticFindingSchema.parse({
        code: "BAD_EVIDENCE",
        severity: "error",
        component: "credential",
        summary: "Credential lookup failed",
        nextAction: "Retry after unlocking the collection",
        evidence: {
          token:
            "swk.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      }),
    ).toThrow();
  });
});
