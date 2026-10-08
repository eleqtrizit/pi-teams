import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFooterSummary,
  buildMigrationNotice,
  buildModelFlavors,
  migrateLegacyFlavors,
  readEnabledModels,
  readFlavoredModels,
  writeFlavorsToSettings,
} from "./flavoredModels";

let settingsDir: string;
let settingsPath: string;

function writeSettingsFile(data: object): void {
  writeFileSync(settingsPath, JSON.stringify(data), "utf-8");
}

beforeEach(() => {
  settingsDir = mkdtempSync(path.join(tmpdir(), "flavored-models-"));
  settingsPath = path.join(settingsDir, "settings.json");
});

afterEach(() => {
  if (settingsDir) {
    rmSync(settingsDir, { recursive: true, force: true });
  }
});

describe("readFlavoredModels", () => {
  it("returns empty lists when flavor keys are missing", () => {
    writeSettingsFile({ enabledModels: ["a", "b"] });
    expect(readFlavoredModels(settingsPath)).toEqual({
      orchestrator: [],
      worker: [],
      swarm: [],
    });
  });

  it("reads all three flavor lists", () => {
    writeSettingsFile({
      enabledModelsOrchestrator: ["o1"],
      enabledModelsWorker: ["w1", "w2"],
      enabledModelsSwarm: ["s1"],
    });
    expect(readFlavoredModels(settingsPath)).toEqual({
      orchestrator: ["o1"],
      worker: ["w1", "w2"],
      swarm: ["s1"],
    });
  });

  it("ignores legacy keys", () => {
    writeSettingsFile({ enabledModelsHigh: ["h1"] });
    expect(readFlavoredModels(settingsPath).orchestrator).toEqual([]);
  });

  it("throws on non-string entries", () => {
    writeSettingsFile({ enabledModelsWorker: ["ok", 42] });
    expect(() => readFlavoredModels(settingsPath)).toThrow(/Non-string value/);
  });
});

describe("migrateLegacyFlavors", () => {
  function readRaw(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath, "utf-8"));
  }

  it("returns null and leaves the file untouched without legacy keys", () => {
    writeSettingsFile({ enabledModelsWorker: ["w1"] });
    const before = readFileSync(settingsPath, "utf-8");
    expect(migrateLegacyFlavors(settingsPath)).toBeNull();
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("maps high to orchestrator and med/fast to worker", () => {
    writeSettingsFile({
      unrelated: { keep: true },
      enabledModelsHigh: ["h1"],
      enabledModelsMed: ["m1"],
      enabledModelsFast: ["f1"],
    });
    expect(migrateLegacyFlavors(settingsPath)).toEqual({
      toOrchestrator: ["h1"],
      toWorker: ["m1", "f1"],
    });
    const raw = readRaw();
    expect(raw.enabledModelsOrchestrator).toEqual(["h1"]);
    expect(raw.enabledModelsWorker).toEqual(["m1", "f1"]);
    expect(raw).not.toHaveProperty("enabledModelsHigh");
    expect(raw).not.toHaveProperty("enabledModelsMed");
    expect(raw).not.toHaveProperty("enabledModelsFast");
    expect(raw.unrelated).toEqual({ keep: true });
  });

  it("deduplicates and appends to existing new-style lists", () => {
    writeSettingsFile({
      enabledModelsWorker: ["w1", "m1"],
      enabledModelsMed: ["m1", "m2"],
      enabledModelsFast: ["m2", "f1"],
    });
    migrateLegacyFlavors(settingsPath);
    expect(readRaw().enabledModelsWorker).toEqual(["w1", "m1", "m2", "f1"]);
  });

  it("removes empty legacy keys and reports an empty move", () => {
    writeSettingsFile({ enabledModelsMed: [] });
    expect(migrateLegacyFlavors(settingsPath)).toEqual({
      toOrchestrator: [],
      toWorker: [],
    });
    expect(readRaw()).not.toHaveProperty("enabledModelsMed");
  });

  it("is idempotent", () => {
    writeSettingsFile({ enabledModelsHigh: ["h1"] });
    expect(migrateLegacyFlavors(settingsPath)).not.toBeNull();
    expect(migrateLegacyFlavors(settingsPath)).toBeNull();
    expect(readRaw().enabledModelsOrchestrator).toEqual(["h1"]);
  });

  it("throws on non-string legacy entries without modifying the file", () => {
    writeSettingsFile({ enabledModelsHigh: ["ok", 42] });
    const before = readFileSync(settingsPath, "utf-8");
    expect(() => migrateLegacyFlavors(settingsPath)).toThrow(/Non-string/);
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });
});

describe("buildMigrationNotice", () => {
  it("names moved models and tells the user to update prompts", () => {
    const notice = buildMigrationNotice({
      toOrchestrator: ["a/h"],
      toWorker: [],
    });
    expect(notice).toContain("high -> orchestrator: a/h");
    expect(notice).toContain("med and fast -> worker: (none)");
    expect(notice).toContain("Review your prompts and skills");
  });
});

describe("readEnabledModels", () => {
  it("returns the master list", () => {
    writeSettingsFile({ enabledModels: ["a", "b"] });
    expect(readEnabledModels(settingsPath)).toEqual(["a", "b"]);
  });

  it("throws when enabledModels is missing or not an array", () => {
    writeSettingsFile({});
    expect(() => readEnabledModels(settingsPath)).toThrow(
      /enabledModels is not an array/,
    );
    writeSettingsFile({ enabledModels: "nope" });
    expect(() => readEnabledModels(settingsPath)).toThrow(
      /enabledModels is not an array/,
    );
  });
});

describe("buildModelFlavors", () => {
  it("assigns none to models not in any flavor list", () => {
    const flavors = { orchestrator: ["a"], worker: ["b"], swarm: [] };
    expect(buildModelFlavors(["a", "b", "c"], flavors)).toEqual([
      { id: "a", flavor: "orchestrator" },
      { id: "b", flavor: "worker" },
      { id: "c", flavor: "none" },
    ]);
  });

  it("lets later lists win on duplicates (swarm > worker > orchestrator)", () => {
    const flavors = { orchestrator: ["x"], worker: ["x"], swarm: ["x"] };
    expect(buildModelFlavors(["x"], flavors)).toEqual([
      { id: "x", flavor: "swarm" },
    ]);
  });
});

describe("buildFooterSummary", () => {
  it("counts each flavor bucket", () => {
    const items = [
      { id: "a", flavor: "orchestrator" as const },
      { id: "b", flavor: "worker" as const },
      { id: "c", flavor: "none" as const },
      { id: "d", flavor: "none" as const },
    ];
    expect(buildFooterSummary(items)).toBe(
      "orchestrator:1 worker:1 swarm:0 none:2",
    );
  });
});

describe("writeFlavorsToSettings round-trip", () => {
  it("writes flavor lists and preserves unrelated keys", () => {
    writeSettingsFile({
      enabledModels: ["a", "b", "c"],
      unrelated: { keep: true },
    });

    const assigned = buildModelFlavors(
      ["a", "b", "c"],
      readFlavoredModels(settingsPath),
    );
    assigned[0].flavor = "orchestrator";
    assigned[1].flavor = "swarm";
    // assigned[2] stays "none"

    writeFlavorsToSettings(assigned, settingsPath);

    const result = readFlavoredModels(settingsPath);
    expect(result.orchestrator).toEqual(["a"]);
    expect(result.swarm).toEqual(["b"]);
    expect(result.worker).toEqual([]);

    // Unrelated keys survive the read-modify-write
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(raw.unrelated).toEqual({ keep: true });
    expect(raw.enabledModels).toEqual(["a", "b", "c"]);
  });
});
