// CLAIM S7: README documents state files that no longer exist.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const readme = fs.readFileSync(path.resolve(__dirname, "../README.md"), "utf-8");
describe("S7 README matches code", () => {
  it("does not list removed state files", () => {
    expect(readme).not.toMatch(/last-awoken|last-message/);
  });
});
