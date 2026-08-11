import { createLoadSkill } from "./application/use-cases/load-skill.js";
import { createReadSkillResource } from "./application/use-cases/read-skill-resource.js";
import { createSearchSkills } from "./application/use-cases/search-skills.js";
import { loadVerifiedCatalogProvider } from "./catalog/version-controlled-provider.js";
import type { ApplicationConfig } from "./config.js";
import { createApp } from "./transport/mcp/app.js";

const TEST_BEARER_TOKEN = "skillwire_test_0123456789abcdef";

export function createApplication(
  config: ApplicationConfig,
  projectRoot = process.cwd(),
) {
  const provider = loadVerifiedCatalogProvider(
    projectRoot,
    "launch-catalog-v1",
  );
  return {
    app: createApp({
      host: config.host,
      bearerToken: config.bearerToken,
      useCases: {
        searchSkills: createSearchSkills(provider.listMetadata()),
        loadSkill: createLoadSkill(provider),
        readSkillResource: createReadSkillResource(provider),
      },
    }),
  };
}

export function createTestApplication() {
  return createApplication({
    host: "127.0.0.1",
    port: 0,
    bearerToken: TEST_BEARER_TOKEN,
  });
}
