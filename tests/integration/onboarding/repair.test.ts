/* eslint-disable @typescript-eslint/require-await -- Async fakes mirror production repair interfaces. */
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  planRepair,
  runRepair,
} from "../../../src/onboarding/application/repair.js";

describe("ownership-proven data-preserving repair", () => {
  it("repairs only a matching owned missing component and never rotates secrets", async () => {
    const installationId = randomUUID();
    const expectedIdentitySha256 = "a".repeat(64);
    const plan = planRepair({
      installationId,
      assets: [
        {
          assetId: randomUUID(),
          kind: "plugin",
          client: "codex",
          locator: "skillwire-autonomous-activation@skillwire",
          expectedIdentitySha256,
          observation: "missing",
        },
        {
          assetId: randomUUID(),
          kind: "mcp-entry",
          client: "claude",
          locator: "external-equivalent",
          expectedIdentitySha256: "b".repeat(64),
          observation: "external",
        },
        {
          assetId: randomUUID(),
          kind: "service-secret",
          client: null,
          locator: "secrets/database-password",
          expectedIdentitySha256: "c".repeat(64),
          observation: "missing",
        },
      ],
    });
    const repair = vi.fn(async () => undefined);
    const rotate = vi.fn(async () => undefined);

    const result = await runRepair({
      plan,
      confirmation: plan.previewHash,
      signal: new AbortController().signal,
      observe: async (asset) => ({
        observation: "missing",
        identitySha256: asset.expectedIdentitySha256,
      }),
      repair,
      rotate,
    });

    expect(result.changedAssets).toHaveLength(1);
    expect(repair).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "plugin", client: "codex" }),
    );
    expect(rotate).not.toHaveBeenCalled();
    expect(plan.blocked.map(({ code }) => code).sort()).toEqual([
      "EXTERNAL_INTEGRATION_NOT_OWNED",
      "SECRET_ROTATION_REQUIRES_EXPLICIT_COMMAND",
    ]);
  });

  it.each(["drifted", "ambiguous"] as const)(
    "blocks %s owned state without mutation",
    async (observation) => {
      const plan = planRepair({
        installationId: randomUUID(),
        assets: [
          {
            assetId: randomUUID(),
            kind: "mcp-entry",
            client: "codex",
            locator: "skillwire:user",
            expectedIdentitySha256: "d".repeat(64),
            observation,
          },
        ],
      });
      const repair = vi.fn(async () => undefined);
      await expect(
        runRepair({
          plan,
          confirmation: plan.previewHash,
          signal: new AbortController().signal,
          observe: async () => ({
            observation,
            identitySha256: "e".repeat(64),
          }),
          repair,
          rotate: vi.fn(),
        }),
      ).resolves.toMatchObject({ changedAssets: [] });
      expect(repair).not.toHaveBeenCalled();
    },
  );

  it("repairs drift only when current ownership remains independently proven", async () => {
    const asset = {
      assetId: randomUUID(),
      kind: "container",
      client: null,
      locator: "skillwire-owned-service",
      expectedIdentitySha256: "f".repeat(64),
      observation: "drifted" as const,
      ownershipProven: true,
    };
    const plan = planRepair({ installationId: randomUUID(), assets: [asset] });
    const repair = vi.fn(async () => undefined);
    await expect(
      runRepair({
        plan,
        confirmation: plan.previewHash,
        signal: new AbortController().signal,
        observe: async () => ({
          observation: "drifted",
          identitySha256: "0".repeat(64),
          ownershipProven: true,
        }),
        repair,
        rotate: vi.fn(),
      }),
    ).resolves.toEqual({ changedAssets: [asset.assetId] });
    expect(repair).toHaveBeenCalledWith(asset);
  });
});
