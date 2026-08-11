export function decodeInertText(
  bytes: Uint8Array,
  errorCode = "RESOURCE_NON_TEXT",
): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(errorCode);
  }
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint === 0 ||
      (codePoint < 32 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13) ||
      (codePoint >= 127 && codePoint <= 159) ||
      codePoint === 0xfffe ||
      codePoint === 0xffff
    ) {
      throw new Error(errorCode);
    }
  }
  const normalized = text.replaceAll("\r\n", "\n").normalize("NFC");
  if (normalized !== text.replaceAll("\r\n", "\n")) {
    throw new Error(errorCode);
  }
  return normalized;
}
