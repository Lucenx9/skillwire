import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COSIGN_3_1_3_TRUSTED_ROOT_MEDIA_TYPE,
  TrustPolicySchema,
} from "../../../src/onboarding/domain/release-manifest.js";
import {
  canonicalJson,
  trustPolicyFixture,
} from "../../helpers/self-hosted-release-fixtures.js";

describe("self-hosted trust policy", () => {
  it("requires bounded signer claims, local trust material, deny sets, validity, and overlap", () => {
    const policy = TrustPolicySchema.parse(trustPolicyFixture());
    expect(policy.cosign.version).toBe("3.1.3");
    expect(policy.signers[0]?.issuer).toBe(
      "https://token.actions.githubusercontent.com",
    );
    expect(policy.signers[0]?.signerId).toBe("github-release-primary");
    expect(policy.minimumReleaseSequence).toBe(1);
    expect(policy.trustedRoot.mediaType).toBe(
      COSIGN_3_1_3_TRUSTED_ROOT_MEDIA_TYPE,
    );
    expect(policy.overlap.requiredSignerCount).toBe(1);
  });

  it("rejects unknown fields and invalid sequence/hash values", () => {
    expect(() =>
      TrustPolicySchema.parse(trustPolicyFixture({ sequence: 0 })),
    ).toThrow();
    expect(() =>
      TrustPolicySchema.parse({ ...trustPolicyFixture(), token: "forbidden" }),
    ).toThrow();
    const schema = JSON.parse(
      readFileSync(
        resolve("distribution/self-hosted/trust-policy.schema.json"),
        "utf8",
      ),
    ) as { additionalProperties?: boolean };
    expect(schema.additionalProperties).toBe(false);
    expect(() =>
      TrustPolicySchema.parse(
        trustPolicyFixture({
          overlap: { previousSequence: 1, requiredSignerCount: 2 },
        }),
      ),
    ).toThrow(/rotation/i);
    expect(() =>
      TrustPolicySchema.parse({
        ...trustPolicyFixture(),
        signers: [
          trustPolicyFixture().signers[0],
          trustPolicyFixture().signers[0],
        ],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      TrustPolicySchema.parse({
        ...trustPolicyFixture(),
        trustedRoot: {
          ...trustPolicyFixture().trustedRoot,
          mediaType: "application/vnd.dev.sigstore.trustedroot.v0.2+json",
        },
      }),
    ).toThrow();
  });

  it("pins one canonical first policy and a complete local TrustedRoot identity", () => {
    const policyBytes = readFileSync(
      resolve("distribution/self-hosted/trust-policy.v1.json"),
    );
    const policy = TrustPolicySchema.parse(
      JSON.parse(policyBytes.toString("utf8")) as unknown,
    );
    expect(policyBytes.at(-1)).not.toBe(0x0a);
    expect(policyBytes.toString("utf8")).toBe(canonicalJson(policy));
    const trustedRoot = readFileSync(
      resolve("distribution/self-hosted/trusted-root.v1.json"),
    );
    expect(policy.trustedRoot.sha256).toBe(
      createHash("sha256").update(trustedRoot).digest("hex"),
    );
    const root = JSON.parse(trustedRoot.toString("utf8")) as {
      mediaType?: string;
      tlogs?: unknown[];
      certificateAuthorities?: unknown[];
    };
    expect(root.mediaType).toBe(COSIGN_3_1_3_TRUSTED_ROOT_MEDIA_TYPE);
    expect(root.tlogs?.length).toBeGreaterThan(0);
    expect(root.certificateAuthorities?.length).toBeGreaterThan(0);
  });
});
