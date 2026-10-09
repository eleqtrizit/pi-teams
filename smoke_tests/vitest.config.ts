import { defineConfig } from "vitest/config";

// Smoke tests assert the CORRECT behavior. A failing test proves a defect.
// Run: npx vitest run --config smoke_tests/vitest.config.ts
export default defineConfig({
  test: { include: ["smoke_tests/**/*.smoke.ts"], testTimeout: 20000 },
});
