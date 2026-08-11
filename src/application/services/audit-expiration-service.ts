import type { ErasureAuditStore } from "../ports/erasure-audit-store.js";

export class AuditExpirationService {
  public constructor(private readonly store: ErasureAuditStore) {}

  public cleanupExpired(): Promise<number> {
    return this.store.deleteExpired();
  }
}
