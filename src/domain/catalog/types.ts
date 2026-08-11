export type TrustAtPublication = "trusted";

export type CurrentAdvisoryStatus = "available" | "unavailable" | "revoked";

export interface CatalogSkillMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly revision: string;
  readonly trustAtPublication: TrustAtPublication;
  readonly currentAdvisoryStatus: CurrentAdvisoryStatus;
}

export interface RankedSkill {
  readonly skill: CatalogSkillMetadata;
  readonly score: number;
  readonly matchingCapabilities: readonly string[];
}

export interface SearchPreview {
  readonly rank: number;
  readonly skillId: string;
  readonly name: string;
  readonly summary: string;
  readonly matchingCapabilities: readonly string[];
  readonly trustAtPublication: TrustAtPublication;
  readonly currentAdvisoryStatus: CurrentAdvisoryStatus;
  readonly revision: string;
}

export interface SearchSkillsResult {
  readonly skills: readonly SearchPreview[];
}
