import { describe, expect, it } from "vitest";
import {
  executeSubTurn,
  parseSubCommandArgs,
  type SubTurnDeps,
} from "./index";

describe("parseSubCommandArgs", () => {
  it("splits the model request from the prompt", () => {
    expect(
      parseSubCommandArgs("opus-4 write a haiku about queues"),
    ).toEqual({
      modelRequest: "opus-4",
      prompt: "write a haiku about queues",
    });
  });

  it("keeps extra whitespace out of the prompt", () => {
    expect(parseSubCommandArgs("  gpt-5    do the thing  ")).toEqual({
      modelRequest: "gpt-5",
      prompt: "do the thing",
    });
  });

  it("rejects input without a prompt", () => {
    expect(parseSubCommandArgs("opus-4")).toBeNull();
    expect(parseSubCommandArgs("   ")).toBeNull();
    expect(parseSubCommandArgs("")).toBeNull();
  });
});

describe("executeSubTurn", () => {
  const originalModel = { provider: "anthropic", model: "claude-opus-4" };

  function makeDeps(
    overrides: Partial<SubTurnDeps> = {},
  ): SubTurnDeps & {
    setModelCalls: Array<{ provider: string; model: string }>;
  } {
    const setModelCalls: Array<{ provider: string; model: string }> = [];
    const deps: SubTurnDeps = {
      originalModel,
      resolve: () => ({ provider: "openai", model: "gpt-5" }),
      setModel: async (ref) => {
        setModelCalls.push(ref);
        return true;
      },
      runPrompt: async () => {},
      waitForIdle: async () => {},
      notify: () => {},
      ...overrides,
    };
    return { ...deps, setModelCalls };
  }

  it("switches to the substitute, runs the prompt, then restores", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      setModel: async (ref) => {
        order.push(`set:${ref.model}`);
        return true;
      },
      runPrompt: async () => {
        order.push("prompt");
      },
      waitForIdle: async () => {
        order.push("idle");
      },
    });
    await executeSubTurn(deps, "gpt-5", "do the thing");
    expect(order).toEqual(["set:gpt-5", "prompt", "idle", "set:claude-opus-4"]);
  });

  it("aborts without switching when resolution fails", async () => {
    const deps = makeDeps({
      resolve: () => null,
      runPrompt: async () => {
        throw new Error("prompt must not run");
      },
    });
    await executeSubTurn(deps, "nonexistent", "do the thing");
    expect(deps.setModelCalls).toEqual([]);
  });

  it("aborts without prompting when the provider is not authenticated", async () => {
    const setModelCalls: Array<{ provider: string; model: string }> = [];
    const deps = makeDeps({
      setModel: async (ref) => {
        setModelCalls.push(ref);
        return false;
      },
      runPrompt: async () => {
        throw new Error("prompt must not run");
      },
    });
    await executeSubTurn(deps, "gpt-5", "do the thing");
    expect(setModelCalls).toEqual([{ provider: "openai", model: "gpt-5" }]);
  });

  it("restores the original model when the prompt run throws", async () => {
    const deps = makeDeps({
      runPrompt: async () => {
        throw new Error("model exploded");
      },
    });
    await expect(
      executeSubTurn(deps, "gpt-5", "do the thing"),
    ).rejects.toThrow("model exploded");
    expect(deps.setModelCalls).toEqual([
      { provider: "openai", model: "gpt-5" },
      { provider: "anthropic", model: "claude-opus-4" },
    ]);
  });

  it("notifies on each phase", async () => {
    const notifications: Array<{ message: string; level: string }> = [];
    const deps = makeDeps({
      notify: (message, level) => {
        notifications.push({ message, level });
      },
    });
    await executeSubTurn(deps, "gpt-5", "do the thing");
    expect(notifications.map((n) => n.level)).toEqual([
      "success",
      "success",
    ]);
    expect(notifications[1].message).toContain("claude-opus-4");
  });

  it("reports errors without prompting when setModel throws", async () => {
    const notifications: Array<{ message: string; level: string }> = [];
    const deps = makeDeps({
      setModel: async () => {
        throw new Error("registry exploded");
      },
      runPrompt: async () => {
        throw new Error("prompt must not run");
      },
      notify: (message, level) => {
        notifications.push({ message, level });
      },
    });
    await executeSubTurn(deps, "gpt-5", "do the thing");
    expect(notifications).toEqual([
      { level: "error", message: expect.stringContaining("registry exploded") },
    ]);
  });

  it("restores the original model when the restore switch throws", async () => {
    const setModelCalls: string[] = [];
    const deps = makeDeps({
      setModel: async (ref) => {
        setModelCalls.push(ref.model);
        if (ref.model === "claude-opus-4") {
          throw new Error("restore blew up");
        }
        return true;
      },
    });
    await executeSubTurn(deps, "gpt-5", "do the thing");
    expect(setModelCalls).toEqual(["gpt-5", "claude-opus-4"]);
  });
});
