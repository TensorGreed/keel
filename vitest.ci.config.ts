import { defineConfig } from "vitest/config";

/**
 * The opt-in CI batteries (test/ci/): the cold-start battery over pinned real repos and the
 * large-repo perf smoke test. Both are minutes-long by nature — a clone, or a 20k-file graph
 * build — so the timeouts are generous and files run one at a time: the perf test measures wall
 * time and peak memory, which a parallel neighbour would make meaningless.
 */
export default defineConfig({
  test: {
    include: ["test/ci/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
