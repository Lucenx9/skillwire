import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiKeyToken } from "../../../src/authentication/api-key-token.js";
import { CredentialResolver } from "../../../src/credential-bridge/credential-resolver.js";
import {
  createOnboardingEnvironment,
  type OnboardingEnvironment,
} from "../../helpers/onboarding-environment.js";

describe("credential resolver Secret Service reference", () => {
  let fixture: OnboardingEnvironment | undefined;

  afterEach(async () => fixture?.close());

  it("accepts the exact client-scoped UUID reference and passes it to lookup", async () => {
    fixture = await createOnboardingEnvironment();
    const installationId = "00000000-0000-4000-8000-000000000001";
    const reference =
      "secret-service:codex:00000000-0000-4000-8000-000000000002";
    const stateRoot = resolve(fixture.xdgStateHome, "skillwire");
    const dataRoot = resolve(fixture.xdgDataHome, "skillwire");
    const installationRoot = resolve(
      stateRoot,
      "installations",
      installationId,
    );
    await mkdir(installationRoot, { recursive: true, mode: 0o700 });
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(installationRoot, "bridge-state.json"),
      `${JSON.stringify({
        schemaVersion: "skillwire.bridge-state/v1",
        installationId,
        endpoint: "http://127.0.0.1:3000/mcp",
        clients: [{ client: "codex", credentialReference: reference }],
      })}\n`,
      { mode: 0o600 },
    );
    const token = createApiKeyToken().token;
    const lookup = vi.fn().mockResolvedValue(token);
    const resolver = new CredentialResolver(stateRoot, dataRoot, {
      lookup,
    } as never);

    await expect(resolver.resolve(installationId, "codex")).resolves.toEqual({
      endpoint: new URL("http://127.0.0.1:3000/mcp"),
      token,
    });
    expect(lookup).toHaveBeenCalledWith(installationId, "codex", reference);
  });
});
