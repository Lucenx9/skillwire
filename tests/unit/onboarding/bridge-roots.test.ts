import { describe, expect, it } from "vitest";

import { resolveBridgeRoots } from "../../../src/credential-bridge/bridge-cli.js";

describe("credential bridge XDG roots", () => {
  it("never falls back to the repository when HOME and XDG roots are absent", () => {
    expect(resolveBridgeRoots({})).toBeUndefined();
    expect(resolveBridgeRoots({ HOME: "relative" })).toBeUndefined();
  });

  it("uses only absolute normal-profile or explicit XDG roots", () => {
    expect(resolveBridgeRoots({ HOME: "/home/disposable" })).toEqual({
      dataRoot: "/home/disposable/.local/share/skillwire",
      stateRoot: "/home/disposable/.local/state/skillwire",
    });
    expect(
      resolveBridgeRoots({
        HOME: "/home/disposable",
        XDG_DATA_HOME: "/tmp/data",
        XDG_STATE_HOME: "/tmp/state",
      }),
    ).toEqual({
      dataRoot: "/tmp/data/skillwire",
      stateRoot: "/tmp/state/skillwire",
    });
  });
});
