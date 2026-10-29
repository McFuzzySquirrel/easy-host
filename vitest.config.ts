import { defineConfig } from "vitest/config";

const integrationEnabled = process.env.EASY_HOST_INTEGRATION === "1";
const packagingEnabled = process.env.EASY_HOST_PACKAGING === "1";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(integrationEnabled ? [] : ["tests/integration/**"]),
      ...(packagingEnabled ? [] : ["tests/packaging/**"]),
    ],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    clearMocks: true,
    restoreMocks: true,
  },
});
