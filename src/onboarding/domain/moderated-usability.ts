import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const PublicCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
const OpaqueIdSchema = z
  .string()
  .regex(/^(?:participant|environment|cohort)-[0-9a-f]{16}$/);

const AssetIdentitySchema = z
  .object({
    path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/),
    size: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 ** 3),
    sha256: Sha256Schema,
  })
  .strict();

const CohortReleaseSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    tag: z.string().regex(/^self-hosted-v\d+\.\d+\.\d+$/),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    assets: z.array(AssetIdentitySchema).length(7),
  })
  .strict()
  .superRefine((release, context) => {
    if (release.tag !== `self-hosted-v${release.version}`) {
      context.addIssue({
        code: "custom",
        path: ["tag"],
        message: "release tag does not match release version",
      });
    }
    const expected = [
      `skillwire-${release.version}-linux-amd64.release.json`,
      `skillwire-${release.version}-linux-amd64.release.sigstore.json`,
      `skillwire-${release.version}-linux-amd64.tar.zst`,
      `skillwire-${release.version}-linux-arm64.release.json`,
      `skillwire-${release.version}-linux-arm64.release.sigstore.json`,
      `skillwire-${release.version}-linux-arm64.tar.zst`,
      "skillwire-trust-policy-v1.json",
    ];
    if (
      !isDeepStrictEqual(
        release.assets.map(({ path }) => path),
        expected,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: "release evidence requires the exact seven ordered assets",
      });
    }
    if (
      new Set(release.assets.map(({ path }) => path)).size !==
      release.assets.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: "release asset identities must be unique",
      });
    }
  });

const DocumentationSchema = z
  .object({
    path: z.literal("distribution/self-hosted/README.md"),
    sha256: Sha256Schema,
  })
  .strict();

const MilestoneNameSchema = z.enum([
  "releaseVerified",
  "serviceReady",
  "clientIntegrated",
  "installationStateIdentified",
  "nextSafeRecoveryActionIdentified",
  "sixToolDiscovery",
  "mcpSearch",
  "exactSkillLoad",
  "optionalResourceJourney",
  "cleanup",
]);

const MilestoneSchema = z
  .object({
    status: z.enum([
      "passed",
      "failed",
      "timeout",
      "abandoned",
      "not-applicable",
    ]),
    publicErrorCodes: z.array(PublicCodeSchema).max(16),
  })
  .strict();

const ParticipantReleaseSchema = CohortReleaseSchema.extend({
  manifestSha256: Sha256Schema,
}).strict();

const REQUIRED_TOOLS = [
  "search_skills",
  "load_skill",
  "get_skill_resource",
  "import_repository",
  "list_repositories",
  "remove_repository",
] as const;
const ToolNameSchema = z.enum(REQUIRED_TOOLS);

const ModeratedParticipantSchema = z
  .object({
    participantId: OpaqueIdSchema.refine((id) => id.startsWith("participant-")),
    independent: z.literal(true),
    previouslyInstalledSkillWire: z.literal(false),
    attemptNumber: z.literal(1),
    replacementForParticipantId: z.null(),
    exclusionReason: z
      .enum([
        "unsupported-environment",
        "prior-install",
        "not-independent",
        "invalid-starting-state",
      ])
      .nullable(),
    environment: z
      .object({
        environmentId: OpaqueIdSchema.refine((id) =>
          id.startsWith("environment-"),
        ),
        clean: z.literal(true),
        operatingSystem: z.union([
          z.object({ id: z.literal("ubuntu"), version: z.literal("24.04") }),
          z.object({ id: z.literal("debian"), version: z.literal("12") }),
          z.object({ id: z.literal("debian"), version: z.literal("13") }),
        ]),
        architecture: z.enum(["amd64", "arm64"]),
        dockerMode: z.enum(["rootful", "rootless"]),
      })
      .strict(),
    startingState: z
      .object({
        skillWireAbsent: z.literal(true),
        serviceAbsent: z.literal(true),
        selectedClientHasNoSkillWireIntegration: z.literal(true),
        noRetainedSkillWireData: z.literal(true),
      })
      .strict(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    elapsedMilliseconds: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60_000),
    release: ParticipantReleaseSchema,
    documentation: DocumentationSchema,
    usedOnlyPublishedQuickstart: z.literal(true),
    manualConfigurationEdited: z.literal(false),
    milestones: z
      .object({
        releaseVerified: MilestoneSchema,
        serviceReady: MilestoneSchema,
        clientIntegrated: MilestoneSchema,
        installationStateIdentified: MilestoneSchema,
        nextSafeRecoveryActionIdentified: MilestoneSchema,
        sixToolDiscovery: MilestoneSchema,
        mcpSearch: MilestoneSchema,
        exactSkillLoad: MilestoneSchema,
        optionalResourceJourney: MilestoneSchema,
        cleanup: MilestoneSchema,
      })
      .strict(),
    publicErrors: z
      .array(
        z
          .object({
            code: PublicCodeSchema,
            milestone: MilestoneNameSchema,
            recovered: z.boolean(),
          })
          .strict(),
      )
      .max(32),
    moderatorInterventions: z
      .array(
        z
          .object({
            occurredAt: z.iso.datetime({ offset: true }),
            category: z.enum([
              "undocumented-command",
              "correction",
              "procedural-instruction",
            ]),
            milestone: MilestoneNameSchema,
            publicCode: PublicCodeSchema,
          })
          .strict(),
      )
      .max(32),
    documentationClarifications: z
      .array(
        z
          .object({
            occurredAt: z.iso.datetime({ offset: true }),
            criterion: z.literal("visible-document-location-only"),
            documentPath: z.literal("distribution/self-hosted/README.md"),
            sectionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
          })
          .strict(),
      )
      .max(32),
    serviceReady: z.boolean(),
    discoveredTools: z
      .array(ToolNameSchema)
      .max(REQUIRED_TOOLS.length)
      .superRefine((tools, context) => {
        if (new Set(tools).size !== tools.length) {
          context.addIssue({
            code: "custom",
            message: "discovered tool identities must be unique",
          });
        }
      }),
    journey: z
      .object({
        searchCompleted: z.boolean(),
        exactSkillLoaded: z.boolean(),
        optionalResourceOutcome: z.enum(["completed", "not-applicable"]),
      })
      .strict(),
    cleanup: z
      .object({
        verified: z.boolean(),
        completedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    completed: z.boolean(),
    unassisted: z.boolean(),
  })
  .strict();

export type ModeratedUsabilityParticipant = z.infer<
  typeof ModeratedParticipantSchema
>;

export interface ModeratedUsabilityAggregation {
  readonly cohortSize: 10;
  readonly completedWithinTarget: number;
  readonly sc001Required: 10;
  readonly sc001Passed: boolean;
  readonly unassistedCompletions: number;
  readonly sc014Required: 9;
  readonly sc014Passed: boolean;
}

const TARGET_MILLISECONDS = 15 * 60_000;

function participantCompletion(
  participant: ModeratedUsabilityParticipant,
): boolean {
  const requiredMilestones = Object.entries(participant.milestones).filter(
    ([name]) => name !== "optionalResourceJourney",
  );
  const optionalResource = participant.milestones.optionalResourceJourney;
  return (
    participant.exclusionReason === null &&
    participant.elapsedMilliseconds <= TARGET_MILLISECONDS &&
    requiredMilestones.every(
      ([, milestone]) => milestone.status === "passed",
    ) &&
    (optionalResource.status === "passed" ||
      optionalResource.status === "not-applicable") &&
    participant.publicErrors.every(({ recovered }) => recovered) &&
    participant.serviceReady &&
    isDeepStrictEqual(participant.discoveredTools, REQUIRED_TOOLS) &&
    participant.journey.searchCompleted &&
    participant.journey.exactSkillLoaded &&
    participant.cleanup.verified
  );
}

export function calculateModeratedUsabilityCohort(
  participants: readonly ModeratedUsabilityParticipant[],
): ModeratedUsabilityAggregation {
  if (participants.length !== 10)
    throw new Error(
      "Moderated usability cohort must contain exactly ten participants",
    );
  const completedWithinTarget = participants.filter(
    participantCompletion,
  ).length;
  const unassistedCompletions = participants.filter(
    (participant) =>
      participantCompletion(participant) &&
      participant.moderatorInterventions.length === 0,
  ).length;
  return {
    cohortSize: 10,
    completedWithinTarget,
    sc001Required: 10,
    sc001Passed: completedWithinTarget === 10,
    unassistedCompletions,
    sc014Required: 9,
    sc014Passed: unassistedCompletions >= 9,
  };
}

const AggregationSchema = z
  .object({
    cohortSize: z.literal(10),
    completedWithinTarget: z.number().int().min(0).max(10),
    sc001Required: z.literal(10),
    sc001Passed: z.boolean(),
    unassistedCompletions: z.number().int().min(0).max(10),
    sc014Required: z.literal(9),
    sc014Passed: z.boolean(),
  })
  .strict();

export const ModeratedUsabilityCohortSchema = z
  .object({
    schemaVersion: z.literal("skillwire.moderated-usability/v1"),
    evidenceKind: z.enum(["synthetic-fixture", "certified-observation"]),
    cohortId: OpaqueIdSchema.refine((id) => id.startsWith("cohort-")),
    targetMilliseconds: z.literal(TARGET_MILLISECONDS),
    release: CohortReleaseSchema,
    documentation: DocumentationSchema,
    participants: z.array(ModeratedParticipantSchema).length(10),
    aggregation: AggregationSchema,
  })
  .strict()
  .superRefine((cohort, context) => {
    const participantIds = new Set<string>();
    const environmentIds = new Set<string>();
    cohort.participants.forEach((participant, index) => {
      if (participantIds.has(participant.participantId)) {
        context.addIssue({
          code: "custom",
          path: ["participants", index, "participantId"],
          message: "participant identities must be unique",
        });
      }
      participantIds.add(participant.participantId);
      if (environmentIds.has(participant.environment.environmentId)) {
        context.addIssue({
          code: "custom",
          path: ["participants", index, "environment", "environmentId"],
          message: "independent participant environments must be unique",
        });
      }
      environmentIds.add(participant.environment.environmentId);
      if (participant.exclusionReason !== null) {
        context.addIssue({
          code: "custom",
          path: ["participants", index, "exclusionReason"],
          message: "an assigned cohort participant cannot be excluded",
        });
      }
      const elapsed =
        Date.parse(participant.endedAt) - Date.parse(participant.startedAt);
      if (elapsed < 0 || elapsed !== participant.elapsedMilliseconds) {
        context.addIssue({
          code: "custom",
          path: ["participants", index, "elapsedMilliseconds"],
          message: "participant duration does not match UTC timestamps",
        });
      }
      const startedAt = Date.parse(participant.startedAt);
      const endedAt = Date.parse(participant.endedAt);
      const requireSessionTimestamp = (
        occurredAt: string,
        path: readonly (string | number)[],
      ): void => {
        const timestamp = Date.parse(occurredAt);
        if (timestamp < startedAt || timestamp > endedAt) {
          context.addIssue({
            code: "custom",
            path: ["participants", index, ...path],
            message: "observation timestamp is outside the participant session",
          });
        }
      };
      participant.moderatorInterventions.forEach(
        ({ occurredAt }, eventIndex) => {
          requireSessionTimestamp(occurredAt, [
            "moderatorInterventions",
            eventIndex,
            "occurredAt",
          ]);
        },
      );
      participant.documentationClarifications.forEach(
        ({ occurredAt }, eventIndex) => {
          requireSessionTimestamp(occurredAt, [
            "documentationClarifications",
            eventIndex,
            "occurredAt",
          ]);
        },
      );
      requireSessionTimestamp(participant.cleanup.completedAt, [
        "cleanup",
        "completedAt",
      ]);
      Object.entries(participant.milestones).forEach(
        ([milestoneName, milestone]) => {
          const isOptional = milestoneName === "optionalResourceJourney";
          if (!isOptional && milestone.status === "not-applicable") {
            context.addIssue({
              code: "custom",
              path: ["participants", index, "milestones", milestoneName],
              message:
                "only the optional resource milestone may be not applicable",
            });
          }
          const requiresErrorCode = ["failed", "timeout", "abandoned"].includes(
            milestone.status,
          );
          if (
            (requiresErrorCode && milestone.publicErrorCodes.length === 0) ||
            (!requiresErrorCode && milestone.publicErrorCodes.length !== 0)
          ) {
            context.addIssue({
              code: "custom",
              path: [
                "participants",
                index,
                "milestones",
                milestoneName,
                "publicErrorCodes",
              ],
              message: "milestone status and public error codes disagree",
            });
          }
          milestone.publicErrorCodes.forEach((code) => {
            if (
              !participant.publicErrors.some(
                (error) =>
                  error.milestone === milestoneName && error.code === code,
              )
            ) {
              context.addIssue({
                code: "custom",
                path: ["participants", index, "publicErrors"],
                message:
                  "milestone public error code has no matching error record",
              });
            }
          });
        },
      );
      participant.publicErrors.forEach((error, errorIndex) => {
        const milestone = participant.milestones[error.milestone];
        if (!milestone.publicErrorCodes.includes(error.code)) {
          context.addIssue({
            code: "custom",
            path: ["participants", index, "publicErrors", errorIndex],
            message: "public error record has no matching milestone code",
          });
        }
      });
      const exactToolsDiscovered = isDeepStrictEqual(
        participant.discoveredTools,
        REQUIRED_TOOLS,
      );
      const expectedStatuses = {
        serviceReady: participant.serviceReady,
        sixToolDiscovery: exactToolsDiscovered,
        mcpSearch: participant.journey.searchCompleted,
        exactSkillLoad: participant.journey.exactSkillLoaded,
        cleanup: participant.cleanup.verified,
      } as const;
      Object.entries(expectedStatuses).forEach(([milestoneName, expected]) => {
        const milestone =
          participant.milestones[
            milestoneName as keyof typeof expectedStatuses
          ];
        if ((milestone.status === "passed") !== expected) {
          context.addIssue({
            code: "custom",
            path: ["participants", index, "milestones", milestoneName],
            message: "milestone status disagrees with structured observation",
          });
        }
      });
      const expectedResourceStatus =
        participant.journey.optionalResourceOutcome === "completed"
          ? "passed"
          : "not-applicable";
      if (
        participant.milestones.optionalResourceJourney.status !==
        expectedResourceStatus
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "participants",
            index,
            "milestones",
            "optionalResourceJourney",
          ],
          message: "optional resource milestone disagrees with journey outcome",
        });
      }
      const participantRelease = {
        version: participant.release.version,
        tag: participant.release.tag,
        sourceCommit: participant.release.sourceCommit,
        assets: participant.release.assets,
      };
      if (!isDeepStrictEqual(participantRelease, cohort.release)) {
        context.addIssue({
          code: "custom",
          path: ["participants", index, "release"],
          message:
            "participant release identity differs from the fixed cohort release identity",
        });
      }
      const manifestPath = `skillwire-${cohort.release.version}-linux-${participant.environment.architecture}.release.json`;
      const manifest = cohort.release.assets.find(
        ({ path }) => path === manifestPath,
      );
      if (manifest?.sha256 !== participant.release.manifestSha256) {
        context.addIssue({
          code: "custom",
          path: ["participants", index, "release", "manifestSha256"],
          message:
            "participant manifest identity does not match the architecture asset",
        });
      }
      if (!isDeepStrictEqual(participant.documentation, cohort.documentation)) {
        context.addIssue({
          code: "custom",
          path: ["participants", index, "documentation"],
          message:
            "participant documentation identity differs from the fixed cohort documentation",
        });
      }
      const completed = participantCompletion(participant);
      const unassisted =
        completed && participant.moderatorInterventions.length === 0;
      if (
        participant.completed !== completed ||
        participant.unassisted !== unassisted
      ) {
        context.addIssue({
          code: "custom",
          path: ["participants", index, "completed"],
          message:
            "participant completion or unassisted result is inconsistent with recorded evidence",
        });
      }
    });
    const calculated = calculateModeratedUsabilityCohort(cohort.participants);
    if (!isDeepStrictEqual(calculated, cohort.aggregation)) {
      context.addIssue({
        code: "custom",
        path: ["aggregation"],
        message: "cohort aggregation does not match participant evidence",
      });
    }
  });

export type ModeratedUsabilityCohort = z.infer<
  typeof ModeratedUsabilityCohortSchema
>;

export function validateModeratedUsabilityCohort(
  input: unknown,
): ModeratedUsabilityCohort {
  return ModeratedUsabilityCohortSchema.parse(input);
}
