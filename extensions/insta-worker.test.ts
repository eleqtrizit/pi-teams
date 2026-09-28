import { describe, expect, it, beforeEach } from "vitest";
import {
  INSTA_NAME_PREFIX,
  INSTA_WORKER_INSTRUCTION,
  clearModelsCache,
  instaWorkerSubject,
  parseInstaWorkerArgs,
  resolveInstaModel,
  resolveInstaTeam,
  resolveSpawnModel,
  uniqueInstaWorkerName,
} from "./index";

describe("parseInstaWorkerArgs", () => {
  it("returns null for empty args", () => {
    expect(parseInstaWorkerArgs("")).toBeNull();
    expect(parseInstaWorkerArgs("   ")).toBeNull();
  });

  it("splits the first token as the model and the rest as the prompt", () => {
    expect(parseInstaWorkerArgs("haiku find all TODOs in src")).toEqual({
      modelRequest: "haiku",
      prompt: "find all TODOs in src",
    });
  });

  it("keeps the slash-separated model request intact", () => {
    const parsed = parseInstaWorkerArgs(
      "bighank/Qwen35Coder-35B patch the failing test and rerun it",
    );
    expect(parsed?.modelRequest).toBe("bighank/Qwen35Coder-35B");
    expect(parsed?.prompt).toBe("patch the failing test and rerun it");
  });

  it("treats a lone model name as an empty prompt", () => {
    expect(parseInstaWorkerArgs("haiku")).toEqual({
      modelRequest: "haiku",
      prompt: "",
    });
  });
});

describe("instaWorkerSubject", () => {
  it("uses the first prompt line as the subject", () => {
    expect(instaWorkerSubject("fix the bug\nalso update the docs")).toBe(
      "fix the bug",
    );
  });

  it("caps the subject at 60 characters", () => {
    expect(instaWorkerSubject("x".repeat(100))).toHaveLength(60);
  });

  it("keeps a single-line short prompt unchanged", () => {
    expect(instaWorkerSubject("short prompt")).toBe("short prompt");
  });
});

describe("uniqueInstaWorkerName", () => {
  const NOW = 1700000000000;
  const BASE = `${INSTA_NAME_PREFIX}${NOW.toString(36)}`;

  it("stamps a fresh name from the timestamp", () => {
    expect(uniqueInstaWorkerName(new Set(), NOW)).toBe(BASE);
  });

  it("suffixes until the name is free", () => {
    const taken = new Set([BASE, `${BASE}-1`]);
    expect(uniqueInstaWorkerName(taken, NOW)).toBe(`${BASE}-2`);
  });
});

describe("resolveInstaTeam", () => {
  const NOW = 1700000000000;

  it("reuses the session's team when it exists on disk", () => {
    const result = resolveInstaTeam(
      "t1",
      (team) => team === "t1",
      NOW,
    );
    expect(result).toEqual({ team: "t1", created: false });
  });

  it("creates a fresh team when no session team is active", () => {
    const result = resolveInstaTeam(undefined, () => true, NOW);
    expect(result).toEqual({
      team: `${INSTA_NAME_PREFIX}${NOW.toString(36)}`,
      created: true,
    });
  });

  it("creates a fresh team when the recorded team directory is gone", () => {
    const result = resolveInstaTeam("t1", () => false, NOW);
    expect(result).toEqual({
      team: `${INSTA_NAME_PREFIX}${NOW.toString(36)}`,
      created: true,
    });
  });
});

describe("resolveInstaModel", () => {
  beforeEach(() => {
    clearModelsCache();
  });

  it("passes default through for lead-model resolution", () => {
    const registry = { getAvailable: () => [] };
    const HERMETIC = { flavoredModelIds: [], scopedPatterns: [] };
    expect(resolveInstaModel("default", registry, HERMETIC)).toEqual({
      resolved: "default",
      matches: [],
    });
  });

  it("resolves bare names through the ladder (tier 3 with no groups set)", () => {
    const registry = {
      getAvailable: () => [{ provider: "bighank", id: "Qwen35Coder-35B" }],
    };
    const result = resolveInstaModel("qwen 35b", registry, {
      flavoredModelIds: [],
      scopedPatterns: [],
    });
    expect(result.resolved).toBe("bighank/Qwen35Coder-35B");
  });

  it("returns a flavored model when flavored models are set", () => {
    const registry = {
      getAvailable: () => [
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "bighank", id: "Qwen35Coder-35B" },
      ],
    };
    const result = resolveInstaModel("qwen 35b", registry, {
      flavoredModelIds: ["anthropic/claude-sonnet-4-5"],
      scopedPatterns: [],
    });
    expect(result.resolved).toBe("anthropic/claude-sonnet-4-5");
  });

  it("resolves unknown names to the closest registry model", () => {
    const registry = {
      getAvailable: () => [{ provider: "bighank", id: "Qwen35Coder-35B" }],
    };
    const result = resolveInstaModel("nonexistent-model", registry, {
      flavoredModelIds: [],
      scopedPatterns: [],
    });
    expect(result.resolved).toBe("bighank/Qwen35Coder-35B");
    expect(result.matches.length).toBeGreaterThan(0);
  });
});

describe("resolveSpawnModel", () => {
  const registry = {
    getAvailable: () => [
      { provider: "bighank", id: "Qwen35Coder-35B" },
      { provider: "anthropic", id: "claude-sonnet-4-5" },
    ],
  };
  const leadModel = { provider: "anthropic", id: "claude-sonnet-4-5" };
  const ctx = { model: leadModel, modelRegistry: registry } as any;

  beforeEach(() => {
    clearModelsCache();
  });

  it("falls back to the team-lead's model for undefined requests", () => {
    expect(resolveSpawnModel(ctx, undefined)).toBe("anthropic/claude-sonnet-4-5");
  });

  it("falls back to the team-lead's model for default requests", () => {
    expect(resolveSpawnModel(ctx, "DEFAULT")).toBe("anthropic/claude-sonnet-4-5");
  });

  it("throws for requests that are not fully qualified", () => {
    expect(() => resolveSpawnModel(ctx, "qwen")).toThrow(
      "not fully qualified",
    );
  });

  it("throws for registry-unknown requests", () => {
    expect(() => resolveSpawnModel(ctx, "bighank/Qwen34Coder-35B")).toThrow(
      "not available in the current registry",
    );
  });

  it("accepts a fully qualified registry-known request", () => {
    expect(resolveSpawnModel(ctx, "bighank/Qwen35Coder-35B")).toBe(
      "bighank/Qwen35Coder-35B",
    );
  });

  it("throws when neither the request nor the lead model resolves", () => {
    const noModelCtx = { model: undefined, modelRegistry: registry } as any;
    expect(() => resolveSpawnModel(noModelCtx, undefined)).toThrow(
      "No model is available for the worker",
    );
  });
});

describe("INSTA_WORKER_INSTRUCTION", () => {
  it("directs the worker to report back and then close itself", () => {
    expect(INSTA_WORKER_INSTRUCTION).toContain("send message to the team-lead");
    expect(INSTA_WORKER_INSTRUCTION).toContain("close_myself");
  });
});
