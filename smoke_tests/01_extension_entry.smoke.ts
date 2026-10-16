// CLAIM S1: spawned workers and peer leads start as plain pi sessions.
// `-ne` drops every configured extension (pi-sandbox included), so launch commands must not carry it or `-e`.
import { describe, expect, it } from "vitest";
import { buildLeadCommand, buildWorkerCommand } from "../src/utils/spawn";

const EXTENSION_FLAG = /(^|\s)-(ne|e)(\s|$)/;

describe("S1 spawned sessions load their configured extensions", () => {
  it("launches workers without extension flags", () => {
    for (const readonlyWorker of [false, true]) {
      const { piCmd } = buildWorkerCommand({ readonlyWorker, thinking: "low" }, "prov/model");
      expect(piCmd).not.toMatch(EXTENSION_FLAG);
      expect(piCmd).toContain("--model 'prov/model");
    }
  });

  it("launches peer leads without extension flags", () => {
    expect(buildLeadCommand("prov/model")).not.toMatch(EXTENSION_FLAG);
    expect(buildLeadCommand()).not.toMatch(EXTENSION_FLAG);
  });
});
