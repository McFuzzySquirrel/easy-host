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
    // The gated integration suites mutate host-global state: add and update
    // share the single managed `easy-host-buildkitd` container, and a second
    // suite's `ensureBuildkit` replaces a daemon it did not start. Running the
    // files concurrently makes each suite stomp the other's build, so they run
    // one at a time. Unit files keep Vitest's default parallelism.
    fileParallelism: !integrationEnabled,
    clearMocks: true,
    restoreMocks: true,
  },
});
