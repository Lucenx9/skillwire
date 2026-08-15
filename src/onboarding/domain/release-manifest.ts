import { z } from "zod";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ImageRepositorySchema = z
  .string()
  .min(3)
  .max(255)
  .regex(
    /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?\/)[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/,
  );
const RelativePayloadPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9@+_,=./-]+$/)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      path
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "unsafe relative path",
  );

const FileIdentitySchema = z
  .object({
    path: RelativePayloadPathSchema,
    size: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 ** 3),
    sha256: Sha256Schema,
  })
  .strict();

export const ReleaseComponentsSchema = z
  .object({
    compose: FileIdentitySchema,
    migrations: z
      .object({
        sha256: Sha256Schema,
        count: z.literal(11),
        latest: z.literal("011"),
        forwardOnly: z.tuple([z.literal("010"), z.literal("011")]),
      })
      .strict(),
    catalog: z
      .object({
        sha256: Sha256Schema,
        advisorySha256: Sha256Schema,
        firstPartyRevisionCount: z.literal(10),
      })
      .strict(),
    adapters: z
      .object({
        codexSha256: Sha256Schema,
        claudeSha256: Sha256Schema,
      })
      .strict(),
  })
  .strict();

export const ReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal("skillwire.release/v1"),
    releaseVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/),
    releaseSequence: z.number().int().positive(),
    publishedAt: z.iso.datetime({ offset: true }),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    trustPolicySequence: z.number().int().positive(),
    trustPolicy: FileIdentitySchema.extend({
      path: z.string().regex(/^skillwire-trust-policy-v[1-9][0-9]*\.json$/),
      size: z
        .number()
        .int()
        .positive()
        .max(1024 * 1024),
    }).strict(),
    signatureBundles: z
      .array(
        z
          .object({
            signerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
            path: z
              .string()
              .regex(
                /^skillwire-[0-9A-Za-z][0-9A-Za-z.+-]*-linux-(?:amd64|arm64)\.release(?:\.[a-z0-9][a-z0-9._-]{0,63})?\.sigstore\.json$/,
              ),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    architecture: z.enum(["amd64", "arm64"]),
    archive: FileIdentitySchema.extend({
      path: z
        .string()
        .regex(
          /^skillwire-[0-9A-Za-z][0-9A-Za-z.+-]*-linux-(amd64|arm64)\.tar\.zst$/,
        ),
    }).strict(),
    payload: z
      .array(
        FileIdentitySchema.extend({
          size: z
            .number()
            .int()
            .nonnegative()
            .max(1024 ** 3),
          mode: z.enum(["0600", "0644", "0700", "0755"]),
        }).strict(),
      )
      .min(1)
      .max(4096)
      .superRefine((entries, context) => {
        const paths = new Set<string>();
        entries.forEach(({ path }, index) => {
          if (paths.has(path))
            context.addIssue({
              code: "custom",
              path: [index, "path"],
              message: "duplicate payload path",
            });
          paths.add(path);
        });
      }),
    images: z
      .array(
        z
          .object({
            role: z.enum(["skillwire", "postgres"]),
            repository: ImageRepositorySchema,
            digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
            platform: z.enum(["linux/amd64", "linux/arm64"]),
          })
          .strict(),
      )
      .length(2)
      .superRefine((images, context) => {
        const roles = new Set(images.map(({ role }) => role));
        if (roles.size !== 2)
          context.addIssue({
            code: "custom",
            message: "each required image role must occur exactly once",
          });
      }),
    compatibility: z
      .object({
        node: z.string().regex(/^24\.[0-9]+\.[0-9]+$/),
        postgresql: z.string().regex(/^17\.[0-9]+$/),
        schemaMinimum: z.number().int().nonnegative(),
        schemaMaximum: z.number().int().nonnegative(),
      })
      .strict()
      .refine(
        ({ schemaMinimum, schemaMaximum }) => schemaMinimum <= schemaMaximum,
        "invalid schema range",
      ),
    feature003Integrity: FileIdentitySchema,
    components: ReleaseComponentsSchema,
  })
  .strict()
  .superRefine(
    (
      {
        releaseVersion,
        architecture,
        archive,
        images,
        trustPolicy,
        trustPolicySequence,
        signatureBundles,
      },
      context,
    ) => {
      if (
        archive.path !==
        `skillwire-${releaseVersion}-linux-${architecture}.tar.zst`
      ) {
        context.addIssue({
          code: "custom",
          path: ["archive", "path"],
          message: "archive is not the exact sibling release filename",
        });
      }
      const expectedPlatform = `linux/${architecture}`;
      images.forEach(({ platform }, index) => {
        if (platform !== expectedPlatform) {
          context.addIssue({
            code: "custom",
            path: ["images", index, "platform"],
            message: "image platform does not match release architecture",
          });
        }
      });
      if (
        trustPolicy.path !==
        `skillwire-trust-policy-v${String(trustPolicySequence)}.json`
      ) {
        context.addIssue({
          code: "custom",
          path: ["trustPolicy", "path"],
          message: "trust policy path does not match its sequence",
        });
      }
      const releaseBase = `skillwire-${releaseVersion}-linux-${architecture}`;
      const bundlePaths = new Set<string>();
      const bundleSignerIds = new Set<string>();
      signatureBundles.forEach(({ path, signerId }, index) => {
        const expectedPath =
          index === 0
            ? `${releaseBase}.release.sigstore.json`
            : `${releaseBase}.release.${signerId}.sigstore.json`;
        if (path !== expectedPath) {
          context.addIssue({
            code: "custom",
            path: ["signatureBundles", index, "path"],
            message: "signature bundle is not the exact sibling filename",
          });
        }
        if (bundlePaths.has(path) || bundleSignerIds.has(signerId)) {
          context.addIssue({
            code: "custom",
            path: ["signatureBundles", index],
            message: "duplicate signature bundle identity",
          });
        }
        bundlePaths.add(path);
        bundleSignerIds.add(signerId);
      });
    },
  );

export const COSIGN_3_1_3_TRUSTED_ROOT_MEDIA_TYPE =
  "application/vnd.dev.sigstore.trustedroot+json;version=0.1" as const;

export const TrustPolicySchema = z
  .object({
    schemaVersion: z.literal("skillwire.trust-policy/v1"),
    sequence: z.number().int().positive(),
    validFrom: z.iso.datetime({ offset: true }),
    validUntil: z.iso.datetime({ offset: true }),
    minimumReleaseSequence: z.number().int().positive(),
    trustedRoot: FileIdentitySchema.omit({ size: true })
      .extend({
        mediaType: z.literal(COSIGN_3_1_3_TRUSTED_ROOT_MEDIA_TYPE),
      })
      .strict(),
    cosign: z
      .object({
        version: z.literal("3.1.3"),
        binaries: z
          .object({ amd64: Sha256Schema, arm64: Sha256Schema })
          .strict(),
      })
      .strict(),
    signers: z
      .array(
        z
          .object({
            signerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
            issuer: z.literal("https://token.actions.githubusercontent.com"),
            repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
            workflow: z
              .string()
              .regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
            refPattern: z.string().regex(/^refs\/tags\/[A-Za-z0-9.*_-]+$/),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    deniedSigners: z.array(z.string().min(1).max(256)).max(32),
    deniedManifestDigests: z.array(Sha256Schema).max(128),
    overlap: z
      .object({
        previousSequence: z.number().int().positive().nullable(),
        requiredSignerCount: z.number().int().min(1).max(2),
      })
      .strict(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (Date.parse(policy.validFrom) >= Date.parse(policy.validUntil)) {
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "invalid validity window",
      });
    }
    const signerIds = new Set<string>();
    const signerIdentities = new Set<string>();
    policy.signers.forEach(({ signerId }, index) => {
      if (signerIds.has(signerId)) {
        context.addIssue({
          code: "custom",
          path: ["signers", index, "signerId"],
          message: "duplicate signer identity",
        });
      }
      signerIds.add(signerId);
      const signer = policy.signers[index];
      if (signer !== undefined) {
        const identity = [
          signer.issuer,
          signer.repository,
          signer.workflow,
          signer.refPattern,
        ].join("\0");
        if (signerIdentities.has(identity)) {
          context.addIssue({
            code: "custom",
            path: ["signers", index],
            message: "duplicate signer cryptographic identity",
          });
        }
        signerIdentities.add(identity);
      }
    });
    const { previousSequence, requiredSignerCount } = policy.overlap;
    if (previousSequence === null && requiredSignerCount !== 1) {
      context.addIssue({
        code: "custom",
        path: ["overlap"],
        message: "a non-rotation policy requires one signer",
      });
    }
    if (
      previousSequence !== null &&
      (previousSequence >= policy.sequence ||
        requiredSignerCount !== 2 ||
        policy.signers.length < 2)
    ) {
      context.addIssue({
        code: "custom",
        path: ["overlap"],
        message:
          "rotation requires the immediately prior policy and two signers",
      });
    }
  });

export const InstalledReleaseSchema = z
  .object({
    schemaVersion: z.literal("skillwire.installed-release/v1"),
    releaseVersion: z.string().min(1).max(64),
    releaseSequence: z.number().int().positive(),
    manifestSha256: Sha256Schema,
    archiveSha256: Sha256Schema,
    trustPolicySequence: z.number().int().positive(),
    installedPath: RelativePayloadPathSchema,
    installedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
export type ReleaseComponents = z.infer<typeof ReleaseComponentsSchema>;
export type TrustPolicy = z.infer<typeof TrustPolicySchema>;
export type InstalledRelease = z.infer<typeof InstalledReleaseSchema>;

export function assertNoReleaseDowngrade(
  current: InstalledRelease | undefined,
  candidate: ReleaseManifest,
): void {
  if (
    current !== undefined &&
    candidate.releaseSequence < current.releaseSequence
  ) {
    throw new Error("Release sequence downgrade is forbidden");
  }
  if (
    current !== undefined &&
    candidate.trustPolicySequence < current.trustPolicySequence
  ) {
    throw new Error("Trust policy sequence downgrade is forbidden");
  }
}

export function assertReleaseCompatibility(
  manifest: ReleaseManifest,
  schemaVersion: number,
): void {
  if (
    schemaVersion < manifest.compatibility.schemaMinimum ||
    schemaVersion > manifest.compatibility.schemaMaximum
  ) {
    throw new Error(
      "Installed database schema is incompatible with this release",
    );
  }
}
