import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for LPAudit.
 *
 * Only unit tests (pure, network-free logic) run by default. Browser-backed
 * crawler integration tests are opt-in via the LPAUDIT_E2E env flag so CI and
 * local runs stay fast and offline.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
