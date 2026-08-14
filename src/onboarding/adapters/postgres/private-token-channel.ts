import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

const MAXIMUM_PRIVATE_TOKEN_BYTES = 256;

export class PrivateTokenChannel {
  private constructor(private readonly handle: FileHandle) {}

  public static async open(path: string): Promise<PrivateTokenChannel> {
    const handle = await open(
      path,
      constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const stats = await handle.stat();
      if (
        !stats.isFIFO() ||
        stats.nlink !== 1 ||
        (process.getuid !== undefined && stats.uid !== process.getuid()) ||
        (stats.mode & 0o777) !== 0o600
      ) {
        throw new Error("Private token channel is not an owned 0600 FIFO");
      }
      return new PrivateTokenChannel(handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  public async receive(): Promise<string> {
    const bytes = Buffer.alloc(MAXIMUM_PRIVATE_TOKEN_BYTES);
    try {
      let bytesRead: number;
      try {
        ({ bytesRead } = await this.handle.read(bytes, 0, bytes.length, null));
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
        ) {
          throw new Error(
            "Private client key producer did not deliver a token",
            { cause: error },
          );
        }
        throw error;
      }
      if (bytesRead < 1 || bytesRead === bytes.length) {
        throw new Error(
          "Private client key producer did not deliver a bounded token",
        );
      }
      return bytes.subarray(0, bytesRead).toString("ascii");
    } finally {
      bytes.fill(0);
    }
  }

  public close(): Promise<void> {
    return this.handle.close();
  }
}
