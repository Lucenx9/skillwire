import { sha256Hex } from "../catalog/canonical-revision.js";

const SUPPORTED_SPDX_IDS = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
]);

export interface PinnedLicenseEvidence {
  readonly declaredSpdxId?: string | undefined;
  readonly detectedSpdxId?: string | undefined;
  readonly licenseText?: string | undefined;
  readonly noticeText?: string | undefined;
  readonly attribution: string;
}

export interface ValidatedPinnedLicense {
  readonly spdxId: string;
  readonly licenseText: string;
  readonly licenseSha256: string;
  readonly noticeText?: string | undefined;
  readonly noticeSha256?: string | undefined;
  readonly attribution: string;
}

export function validatePinnedLicense(
  evidence: PinnedLicenseEvidence,
): ValidatedPinnedLicense {
  const declared = evidence.declaredSpdxId;
  const detected = evidence.detectedSpdxId;
  const spdxId = declared ?? detected;
  if (spdxId === undefined || evidence.licenseText === undefined) {
    throw new Error("LICENSE_MISSING");
  }
  if (!SUPPORTED_SPDX_IDS.has(spdxId)) throw new Error("LICENSE_UNSUPPORTED");
  if (
    declared !== undefined &&
    detected !== undefined &&
    declared !== detected
  ) {
    throw new Error("LICENSE_CONFLICT");
  }
  const attribution = evidence.attribution.trim();
  if (attribution.length === 0 || attribution.length > 200) {
    throw new Error("ATTRIBUTION_MISSING");
  }
  const licenseText = evidence.licenseText
    .replaceAll("\r\n", "\n")
    .normalize("NFC");
  if (licenseText.includes("\u0000") || licenseText.length === 0) {
    throw new Error("LICENSE_MISSING");
  }
  const noticeText = evidence.noticeText
    ?.replaceAll("\r\n", "\n")
    .normalize("NFC");
  return {
    spdxId,
    licenseText,
    licenseSha256: sha256Hex(licenseText),
    attribution,
    ...(noticeText === undefined
      ? {}
      : { noticeText, noticeSha256: sha256Hex(noticeText) }),
  };
}

export function detectSpdxLicense(licenseText: string): string | undefined {
  const normalized = licenseText.toLowerCase();
  if (
    normalized.includes("mit license") &&
    normalized.includes("permission is hereby granted")
  ) {
    return "MIT";
  }
  if (
    normalized.includes("apache license") &&
    normalized.includes("version 2.0")
  ) {
    return "Apache-2.0";
  }
  if (
    normalized.includes("mozilla public license") &&
    normalized.includes("2.0")
  ) {
    return "MPL-2.0";
  }
  if (
    normalized.includes("gnu general public license") &&
    normalized.includes("version 3")
  ) {
    return "GPL-3.0-only";
  }
  if (
    normalized.includes("isc license") ||
    normalized.includes("permission to use, copy, modify")
  ) {
    return "ISC";
  }
  return undefined;
}

export function detectAttribution(licenseText: string): string | undefined {
  const match =
    /^copyright(?:\s+\(c\))?\s+(?:\d{4}(?:-\d{4})?\s+)?(.+)$/im.exec(
      licenseText,
    );
  return match?.[1]?.trim();
}
