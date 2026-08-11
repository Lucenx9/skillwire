import { advisoryStatusFor } from "../../domain/catalog/advisory-chain.js";
import type {
  CurrentAdvisoryStatus,
  VerifiedAdvisoryChain,
} from "../../domain/catalog/types.js";

export class AdvisoryStatusService {
  public constructor(private readonly chain: VerifiedAdvisoryChain) {}

  public statusFor(skillId: string, revision: string): CurrentAdvisoryStatus {
    return advisoryStatusFor(this.chain, skillId, revision);
  }
}
