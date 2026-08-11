import { createSearchSkills } from "./application/use-cases/search-skills.js";
import { loadCatalogMetadata } from "./catalog/catalog-loader.js";
import type { ApplicationConfig } from "./config.js";
import { createApp } from "./transport/mcp/app.js";

const TEST_BEARER_TOKEN = "skillwire_test_0123456789abcdef";

export function createApplication(config: ApplicationConfig) {
  const catalog = loadCatalogMetadata();
  const searchSkills = createSearchSkills(catalog);
  return {
    app: createApp({
      host: config.host,
      bearerToken: config.bearerToken,
      searchSkills,
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
