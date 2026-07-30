import { defineConfig } from "vitest/config";

/**
 * The default suite: everything under test/, EXCEPT test/ci/. Those are opt-in batteries that
 * clone from the network or generate a 20k-file repo — minutes, not seconds — so they'd wreck
 * `npm test` as a development loop. They run on their own schedules; see vitest.ci.config.ts,
 * `npm run test:coldstart` / `npm run test:perf`, and the workflows that drive them.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/ci/**", "node_modules/**", "dist/**"],
  },
});
