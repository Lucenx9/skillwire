export class ClientMutationNotStartedError extends Error {
  public constructor(
    readonly stage: "mcp" | "plugin",
    message: string,
  ) {
    super(message);
    this.name = "ClientMutationNotStartedError";
  }
}
