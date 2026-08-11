export interface ErasureAuditRecord {
  readonly accountId: string;
  readonly requestId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly operationResult: "forgotten";
  readonly removedRecordCount: number;
}

export interface ErasureAuditStore {
  listActive(accountId: string): Promise<readonly ErasureAuditRecord[]>;
  deleteExpired(): Promise<number>;
}
