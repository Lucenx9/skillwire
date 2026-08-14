import { describe, expect, it } from "vitest";

import { dockerProcessEnvironment } from "../../../src/onboarding/adapters/docker/environment.js";

describe("Docker subprocess environment isolation", () => {
  it("keeps only runtime routing and explicit non-secret Compose values", () => {
    const environment = dockerProcessEnvironment(
      {
        HOME: "/tmp/disposable-home",
        XDG_RUNTIME_DIR: "/tmp/disposable-runtime",
        DOCKER_HOST: "unix:///tmp/disposable-runtime/docker.sock",
        DOCKER_CONTEXT: "rootless",
        LANG: "it_IT.UTF-8",
        GH_TOKEN: "ambient-github-canary",
        OPENAI_API_KEY: "ambient-openai-canary",
        DATABASE_URL: "postgres://ambient-secret",
      },
      {
        SKILLWIRE_COMPOSE_PROJECT: "skillwire-test",
        SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE:
          "/tmp/disposable/secrets/database-password",
      },
    );

    expect(environment).toMatchObject({
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: "/tmp/disposable-home",
      XDG_RUNTIME_DIR: "/tmp/disposable-runtime",
      DOCKER_HOST: "unix:///tmp/disposable-runtime/docker.sock",
      DOCKER_CONTEXT: "rootless",
      SKILLWIRE_COMPOSE_PROJECT: "skillwire-test",
      SKILLWIRE_DATABASE_PASSWORD_SECRET_FILE:
        "/tmp/disposable/secrets/database-password",
    });
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("DATABASE_URL");
  });
});
