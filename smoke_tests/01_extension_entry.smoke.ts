// CLAIM S1: spawned workers must load extensions/index.ts via `-e <entry>`.
// After extracting spawn.ts, EXTENSION_ENTRY resolves to spawn.ts, which has no default export.
import { describe, expect, it } from "vitest";
import { extensionLoadFlags } from "../src/utils/spawn";
import fs from "node:fs";
import path from "node:path";

describe("S1 worker extension entry", () => {
  it("points -e at extensions/index.ts", () => {
    const entry = path.resolve(__dirname, "../extensions/index.ts");
    const flags = extensionLoadFlags(entry);
    console.log("flags:", flags);
    expect(flags).toBe(`-ne -e '${entry}'`);
  });
  it("the index.ts source passes its own entry (not a helper module) to the flags", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../extensions/index.ts"), "utf-8");
    expect(src).toMatch(/extensionLoadFlags\(EXTENSION_ENTRY\)/);
    expect(src).toMatch(/const EXTENSION_ENTRY/);
  });
});
