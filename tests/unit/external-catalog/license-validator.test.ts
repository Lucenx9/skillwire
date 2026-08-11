import { describe, expect, it } from "vitest";

import {
  detectSpdxLicense,
  validatePinnedLicense,
} from "../../../src/domain/external-catalog/license-validator.js";

describe("pinned source license validation", () => {
  it("retains SPDX license text and attribution", () => {
    expect(
      validatePinnedLicense({
        declaredSpdxId: "MIT",
        detectedSpdxId: "MIT",
        licenseText: "MIT License\n\nCopyright 2026 Example Maintainer\n",
        attribution: "Example Maintainer",
      }),
    ).toMatchObject({ spdxId: "MIT", attribution: "Example Maintainer" });
  });

  it.each([
    [
      {
        declaredSpdxId: undefined,
        detectedSpdxId: undefined,
        licenseText: undefined,
        attribution: "A",
      },
      "LICENSE_MISSING",
    ],
    [
      {
        declaredSpdxId: "GPL-1.0",
        detectedSpdxId: "GPL-1.0",
        licenseText: "License",
        attribution: "A",
      },
      "LICENSE_UNSUPPORTED",
    ],
    [
      {
        declaredSpdxId: "MIT",
        detectedSpdxId: "Apache-2.0",
        licenseText: "MIT License",
        attribution: "A",
      },
      "LICENSE_CONFLICT",
    ],
    [
      {
        declaredSpdxId: "MIT",
        detectedSpdxId: "MIT",
        licenseText: "MIT License",
        attribution: "",
      },
      "ATTRIBUTION_MISSING",
    ],
  ] as const)("quarantines invalid license evidence", (input, code) => {
    expect(() => validatePinnedLicense(input)).toThrow(code);
  });

  it.each([
    ["MIT License\nPermission is hereby granted", "MIT"],
    ["Apache License\nVersion 2.0", "Apache-2.0"],
    ["Mozilla Public License 2.0", "MPL-2.0"],
    [
      "Redistribution and use in source and binary forms are permitted. Neither the name may be used.",
      "BSD-3-Clause",
    ],
    [
      "Redistribution and use in source and binary forms are permitted subject to this list of conditions.",
      "BSD-2-Clause",
    ],
    ["ISC License\nPermission to use, copy, modify", "ISC"],
  ])("detects supported SPDX evidence deterministically %#", (text, spdx) => {
    expect(detectSpdxLicense(text)).toBe(spdx);
  });
});
