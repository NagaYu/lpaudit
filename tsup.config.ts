import { defineConfig } from "tsup";

/**
 * tsup build configuration for LPAudit.
 *
 * Produces a single ESM bundle with a shebang so `dist/index.js` is directly
 * executable as the `lpaudit` bin. Type declarations are emitted for library
 * consumers, and Playwright is kept external (it ships its own browsers).
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  // Ship Playwright as a runtime dependency rather than bundling it.
  external: ["playwright"],
  // No banner needed: the `#!/usr/bin/env node` shebang in src/index.ts is
  // preserved by tsup, so adding one here would duplicate it.
});
