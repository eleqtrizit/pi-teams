import { defineConfig } from "vitest/config";

// Config for the filelock contention child suites only. The main suite never
// loads these (its include pattern covers src/ and extensions/ only), and this
// config loads only test/: no test-setup.ts, so no registry isolation that
// would disturb the parent-provided environment.
export default defineConfig({
  test: {
    include: ["test/*.test.ts"],
  },
});
