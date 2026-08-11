import { describe, expect, it } from "vitest";

import { assertSafeResourcePath } from "../../../src/domain/catalog/resource-path.js";
import { normalizeUtf8 } from "../../../src/domain/catalog/text-normalization.js";

describe("catalog resource safety", () => {
  it.each([
    "../secret.md",
    "references/../../secret.md",
    "/absolute.md",
    "references\\secret.md",
    "references/%2e%2e/secret.md",
  ])("rejects unsafe path %s", (path) => {
    expect(() => {
      assertSafeResourcePath(path);
    }).toThrow();
  });

  it("rejects oversized text", () => {
    expect(() => normalizeUtf8(Buffer.alloc(262_145, 0x61))).toThrow(/size/i);
  });

  it("rejects invalid UTF-8 and NUL as non-text content", () => {
    expect(() => normalizeUtf8(Buffer.from([0xff, 0xfe]))).toThrow(/UTF-8/i);
    expect(() => normalizeUtf8(Buffer.from("text\u0000data"))).toThrow(/NUL/i);
  });
});
