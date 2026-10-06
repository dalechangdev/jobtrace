import { defineConfig } from "vitest/config";

// End-to-end tests of the web UI against a real server. Run with `pnpm test:e2e`,
// which builds the UI first.
export default defineConfig({
  test: {
    include: ["apps/web/e2e/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // The UI polls the server once a second; one second is too tight for these waits.
    expect: { poll: { timeout: 15_000 } },
  },
});
