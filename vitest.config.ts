import { defineConfig } from "vitest/config";

const project = (name: string, include: string[]) => ({
  test: {
    name,
    include,
    environment: "node" as const,
    restoreMocks: true,
  },
});

export default defineConfig({
  test: {
    projects: [
      project("unit", ["tests/unit/**/*.test.ts"]),
      project("contract", ["tests/contract/**/*.test.ts"]),
      project("integration", ["tests/integration/**/*.test.ts"]),
      project("e2e", ["tests/e2e/**/*.test.ts"]),
      project("evaluation", ["tests/evaluation/**/*.test.ts"]),
      project("security", ["tests/security/**/*.test.ts"]),
    ],
  },
});
