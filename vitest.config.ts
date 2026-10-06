import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      // The recorder's injected script runs inside the browser, where Node's
      // coverage cannot see it; it is exercised through real pages instead.
      exclude: ["**/*.test.ts", "packages/test-sites/**", "packages/recorder/src/injected/**"],
    },
  },
});
