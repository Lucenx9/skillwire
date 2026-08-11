export const MAX_TEXT_BYTES = 262_144;

export interface NormalizedText {
  readonly text: string;
  readonly byteLength: number;
}

export function normalizeUtf8(
  bytes: Uint8Array,
  maximumBytes = MAX_TEXT_BYTES,
): NormalizedText {
  if (bytes.byteLength > maximumBytes) {
    throw new Error("Text exceeds the configured size limit");
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Content is not valid UTF-8");
  }

  if (decoded.includes("\u0000")) throw new Error("Text must not contain NUL");
  const withoutBom = decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;
  const text = withoutBom
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .normalize("NFC");
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > maximumBytes) {
    throw new Error("Normalized text exceeds the configured size limit");
  }
  return { text, byteLength };
}
