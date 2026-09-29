import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  completeModelArg,
  createBangModelCompletionFactory,
  getTopModelMatches,
  parseBangModelCommand,
  clearModelsCache,
  resolveModelWithProvider,
  scopedPatternMatches,
  formatDeliveredMessages,
  FollowUpMessageQueue,
  mergeQueuedMessages,
  classifyModel,
  executeGetModels,
} from "./index";
import type { InboxMessage } from "../src/utils/models";
import * as flavoredModels from "../src/utils/flavoredModels";

describe("classifyModel", () => {
  it('classifies GPT and Claude models as "frontier" (case-insensitive)', () => {
    expect(classifyModel("openai-codex/gpt-5.5")).toBe("frontier");
    expect(classifyModel("anthropic/claude-sonnet-4.5")).toBe("frontier");
    expect(classifyModel("openai/GPT-4o-mini")).toBe("frontier");
  });

  it('classifies other models as "oss"', () => {
    expect(classifyModel("bighank/Qwen35Coder-35B-NoThinking")).toBe("oss");
    expect(classifyModel("deepseek/deepseek-v3")).toBe("oss");
    expect(classifyModel("nvidia/nemotron-70b")).toBe("oss");
  });
});

describe("executeGetModels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("partitions enabled models into oss and frontier lists", () => {
    vi.spyOn(flavoredModels, "readEnabledModels").mockReturnValue([
      "openai-codex/gpt-5.5",
      "bighank/Qwen35Coder-35B-NoThinking",
      "anthropic/claude-sonnet-4.5",
    ]);

    const result = executeGetModels();

    expect(result.details).toEqual({
      oss: ["bighank/Qwen35Coder-35B-NoThinking"],
      frontier: ["openai-codex/gpt-5.5", "anthropic/claude-sonnet-4.5"],
    });
    expect(result.content[0].text).toContain("## OSS Models");
    expect(result.content[0].text).toContain("## Frontier Models");
  });

  it("renders (none) placeholders for an empty list", () => {
    vi.spyOn(flavoredModels, "readEnabledModels").mockReturnValue([]);

    const result = executeGetModels();

    expect(result.details).toEqual({ oss: [], frontier: [] });
    expect(result.content[0].text).toContain("(none)");
  });
});

describe("getTopModelMatches", () => {
  beforeEach(() => {
    clearModelsCache();
  });

  it('returns qwen3-coder-480b for "qwen 480b" queries', () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "abuntu", id: "Qwen35Coder-122B" },
        { provider: "abuntu", id: "qwen3-coder-480b" },
        { provider: "openai", id: "o1" },
        { provider: "openai", id: "o3" },
        { provider: "openrouter", id: "openai/o1" },
        { provider: "openrouter", id: "openai/o3" },
        { provider: "openrouter", id: "qwen/qwq-32b" },
        { provider: "openrouter", id: "qwen/qwen3-coder-480b" },
      ],
    };

    const matches = getTopModelMatches("qwen 480b", modelRegistry, 5);
    const models = matches.map((match) => match.model);

    expect(models[0]).toBe("abuntu/qwen3-coder-480b");
    expect(models).toContain("abuntu/qwen3-coder-480b");
    expect(models).toContain("openrouter/qwen/qwen3-coder-480b");
    expect(models.indexOf("openrouter/qwen/qwen3-coder-480b")).toBeLessThan(
      models.indexOf("openrouter/qwen/qwq-32b"),
    );
  });

  describe("bighank/Qwen35Coder-35B-NoThinking matching", () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "bighank", id: "Qwen35Coder-35B-NoThinking" },
        { provider: "bighank", id: "Qwen35Coder-122B" },
        { provider: "openrouter", id: "qwen/qwen3-coder-480b" },
        { provider: "abuntu", id: "some-other-model" },
      ],
    };

    it('returns bighank/Qwen35Coder-35B-NoThinking for "bighank qwen3 35b"', () => {
      const matches = getTopModelMatches("bighank qwen3 35b", modelRegistry, 5);
      expect(matches[0].model).toBe("bighank/Qwen35Coder-35B-NoThinking");
    });

    it('returns bighank/Qwen35Coder-35B-NoThinking for "bighank qwen 35b"', () => {
      const matches = getTopModelMatches("bighank qwen 35b", modelRegistry, 5);
      expect(matches[0].model).toBe("bighank/Qwen35Coder-35B-NoThinking");
    });

    it('returns bighank/Qwen35Coder-35B-NoThinking for "qwen35b on bighank"', () => {
      const matches = getTopModelMatches(
        "qwen35b on bighank",
        modelRegistry,
        5,
      );
      expect(matches[0].model).toBe("bighank/Qwen35Coder-35B-NoThinking");
    });

    it('returns bighank/Qwen35Coder-35B-NoThinking for "qwen 35b bighank"', () => {
      const matches = getTopModelMatches("qwen 35b bighank", modelRegistry, 5);
      expect(matches[0].model).toBe("bighank/Qwen35Coder-35B-NoThinking");
    });
  });
});

describe("resolveModelWithProvider", () => {
  beforeEach(() => {
    clearModelsCache();
  });

  it("returns null when provider prefix is specified but provider not in registry", () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "openrouter", id: "qwen3coder-35b" },
        { provider: "abuntu", id: "qwen3-coder-480b" },
      ],
    };
    const resolved = resolveModelWithProvider(
      "bighank/qwen3coder-35b",
      modelRegistry,
      { flavoredModelIds: [], scopedPatterns: [] },
    );
    expect(resolved).toBeNull();
  });

  it('resolves "bighank/Qwen35 35b" to bighank/qwen3coder-35b via composite token matching', () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "bighank", id: "qwen3coder-35b" },
        { provider: "bighank", id: "Qwen35Coder-122B" },
        { provider: "openrouter", id: "qwen/qwen3-coder-480b" },
      ],
    };
    const resolved = resolveModelWithProvider(
      "bighank/Qwen35 35b",
      modelRegistry,
      { flavoredModelIds: [], scopedPatterns: [] },
    );
    expect(resolved).toBe("bighank/qwen3coder-35b");
  });

  it("returns as-is when provider/model exists in registry", () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "bighank", id: "qwen3coder-35b" },
        { provider: "openrouter", id: "qwen3coder-35b" },
      ],
    };
    const resolved = resolveModelWithProvider(
      "bighank/qwen3coder-35b",
      modelRegistry,
      { flavoredModelIds: [], scopedPatterns: [] },
    );
    expect(resolved).toBe("bighank/qwen3coder-35b");
  });
});

describe("resolveModelWithProvider resolution ladder", () => {
  beforeEach(() => {
    clearModelsCache();
  });

  const registry = {
    getAvailable: () => [
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "bighank", id: "Qwen35Coder-35B" },
      { provider: "openai", id: "gpt-5" },
    ],
  };

  it("returns a flavored model even when the request names a non-flavored model", () => {
    const resolved = resolveModelWithProvider("Qwen35Coder-35B", registry, {
      flavoredModelIds: ["anthropic/claude-sonnet-4-5"],
      scopedPatterns: [],
    });
    expect(resolved).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns a scoped model when no flavored models are set", () => {
    const resolved = resolveModelWithProvider("gpt-5", registry, {
      flavoredModelIds: [],
      scopedPatterns: ["bighank/*"],
    });
    expect(resolved).toBe("bighank/Qwen35Coder-35B");
  });

  it("fuzzy-matches the entire registry when neither group is set", () => {
    const resolved = resolveModelWithProvider("gpt5", registry, {
      flavoredModelIds: [],
      scopedPatterns: [],
    });
    expect(resolved).toBe("openai/gpt-5");
  });
});

describe("scopedPatternMatches", () => {
  const entry = { provider: "github-copilot", model: "gpt-4o" };

  it("matches provider-prefixed patterns case-insensitively", () => {
    expect(scopedPatternMatches("github-copilot/gpt-4o", entry)).toBe(true);
    expect(scopedPatternMatches("GITHUB-COPILOT/GPT-4O", entry)).toBe(true);
    expect(scopedPatternMatches("openai/gpt-4o", entry)).toBe(false);
  });

  it("supports * and ? globs against the pair and the bare id", () => {
    expect(scopedPatternMatches("github-copilot/*", entry)).toBe(true);
    expect(scopedPatternMatches("*gpt-4o", entry)).toBe(true);
    expect(scopedPatternMatches("github-copilot/gpt-?o", entry)).toBe(true);
    expect(scopedPatternMatches("github-copilot/gpt-?x", entry)).toBe(false);
  });

  it("ignores a :thinking-level suffix while matching", () => {
    expect(scopedPatternMatches("github-copilot/gpt-4o:high", entry)).toBe(
      true,
    );
    expect(scopedPatternMatches("github-copilot/gpt-4o:xhigh", entry)).toBe(
      false,
    );
  });
});

describe("formatDeliveredMessages", () => {
  it("returns an empty string for no messages", () => {
    expect(formatDeliveredMessages([])).toBe("");
  });

  it("formats a single message with header fields and body", () => {
    const messages: InboxMessage[] = [
      {
        id: "aaa11111",
        from: "worker",
        to: "team-lead",
        subject: "Status update",
        text: "first report",
        timestamp: "2026-05-28T10:00:00.000Z",
        delivered: true,
        summary: "report",
      },
    ];

    const output = formatDeliveredMessages(messages);
    expect(output).toContain("**From:** worker");
    expect(output).toContain("**To:** team-lead");
    expect(output).toContain("**Subject:** Status update");
    expect(output).toContain("**Timestamp:** 2026-05-28 10:00:00");
    expect(output).toContain("first report");
    expect(output).not.toContain("delivered-message");
  });

  it("wraps multiple messages with ordered boundaries", () => {
    const messages: InboxMessage[] = [
      {
        id: "aaa11111",
        from: "worker",
        to: "team-lead",
        subject: "First",
        text: "body one",
        timestamp: "2026-05-28T10:00:00.000Z",
        delivered: true,
      },
      {
        id: "bbb22222",
        from: "worker",
        to: "team-lead",
        subject: "Second",
        text: "body two",
        timestamp: "2026-05-28T10:01:00.000Z",
        delivered: true,
      },
    ];

    const output = formatDeliveredMessages(messages);
    expect(output).toContain("Multiple messages were delivered");
    expect(output).toContain('<delivered-message index="1">');
    expect(output).toContain('<delivered-message index="2">');
    expect(output).toContain("body one");
    expect(output).toContain("body two");
  });
});

describe("mergeQueuedMessages", () => {
  it("returns nothing for an empty queue", () => {
    expect(mergeQueuedMessages([])).toBe("");
  });

  it("preserves one queued message unchanged", () => {
    expect(mergeQueuedMessages(["Read the new inbox message."])).toBe(
      "Read the new inbox message.",
    );
  });

  it("combines multiple queued messages in order with explicit boundaries", () => {
    expect(
      mergeQueuedMessages([
        "Read the new inbox message.",
        "Report back to the team-lead.",
      ]),
    ).toBe(
      [
        "Multiple queued messages were produced. Address all of them:",
        '<queued-message index="1">\nRead the new inbox message.\n</queued-message>',
        '<queued-message index="2">\nReport back to the team-lead.\n</queued-message>',
      ].join("\n\n"),
    );
  });
});

describe("FollowUpMessageQueue", () => {
  it("sends ten queued messages in one outgoing follow-up", () => {
    const queue = new FollowUpMessageQueue();
    const sendUserMessage = vi.fn();

    for (let index = 1; index <= 10; index++) {
      queue.enqueue(`Message ${index}.`);
    }
    queue.flush((message) =>
      sendUserMessage(message, { deliverAs: "followUp" }),
    );

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        '<queued-message index="10">\nMessage 10.\n</queued-message>',
      ),
      { deliverAs: "followUp" },
    );
  });

  it("clears the queue before sending to prevent reentrant leakage", () => {
    const queue = new FollowUpMessageQueue();
    const sentMessages: string[] = [];
    queue.enqueue("First run.");

    queue.flush((message) => {
      sentMessages.push(message);
      queue.enqueue("Second run.");
    });
    queue.flush((message) => sentMessages.push(message));

    expect(sentMessages).toEqual(["First run.", "Second run."]);
  });

  it("ignores empty messages", () => {
    const queue = new FollowUpMessageQueue();
    const sentMessages: string[] = [];

    queue.enqueue("  ");
    queue.flush((message) => sentMessages.push(message));

    expect(sentMessages).toEqual([]);
  });
});

describe("completeModelArg", () => {
  const models = [
    { provider: "anthropic", model: "claude-opus-4" },
    { provider: "anthropic", model: "claude-sonnet-4.5" },
    { provider: "openai", model: "gpt-5" },
  ];

  it("completes by model name substring", () => {
    expect(completeModelArg("opus", models)).toEqual([
      { label: "anthropic/claude-opus-4", value: "anthropic/claude-opus-4" },
    ]);
  });

  it("completes by provider substring", () => {
    expect(completeModelArg("anth", models)).toHaveLength(2);
  });

  it("narrowers by provider prefix before the slash", () => {
    expect(completeModelArg("openai/g", models)).toEqual([
      { label: "openai/gpt-5", value: "openai/gpt-5" },
    ]);
  });

  it("matches provider and model case-insensitively", () => {
    expect(completeModelArg("OpenAI/GPT", models)).toEqual([
      { label: "openai/gpt-5", value: "openai/gpt-5" },
    ]);
  });

  it("offers every model for an empty prefix", () => {
    expect(completeModelArg("", models)).toHaveLength(3);
  });

  it("suppresses completions once the prompt is being typed", () => {
    expect(completeModelArg("opus write a haiku", models)).toBeNull();
    expect(completeModelArg("openai/gpt-5 do the thing", models)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(completeModelArg("_nomatch", models)).toBeNull();
    expect(completeModelArg("nothing/gpt", models)).toBeNull();
  });

  it("caps the entry count at maxItems", () => {
    expect(completeModelArg("", models, 2)).toHaveLength(2);
  });
});

describe("parseBangModelCommand", () => {
  it("maps one dollar to the substitute-turn command", () => {
    expect(parseBangModelCommand("$opus-4 write a haiku")).toEqual({
      kind: "sub",
      modelRequest: "opus-4",
      prompt: "write a haiku",
    });
  });

  it("maps two dollars to the worker command", () => {
    expect(parseBangModelCommand("$$openai/gpt-5 do the thing")).toEqual({
      kind: "worker",
      modelRequest: "openai/gpt-5",
      prompt: "do the thing",
    });
  });

  it("maps three dollars to the read-only worker command", () => {
    expect(parseBangModelCommand("$$$nemotron audit the schema")).toEqual({
      kind: "readonly-worker",
      modelRequest: "nemotron",
      prompt: "audit the schema",
    });
  });

  it("leaves dollar amounts as ordinary text", () => {
    expect(parseBangModelCommand("$100 budget note")).toBeNull();
    expect(parseBangModelCommand("$$100 total")).toBeNull();
  });

  it("rejects missing or blank prompts", () => {
    expect(parseBangModelCommand("$opus-4")).toBeNull();
    expect(parseBangModelCommand("$opus-4   ")).toBeNull();
  });

  it("rejects missing model tokens", () => {
    expect(parseBangModelCommand("$ write a haiku")).toBeNull();
  });

  it("treats four or more dollars as ordinary text", () => {
    expect(parseBangModelCommand("$$$$$ money money money")).toBeNull();
  });
});

describe("createBangModelCompletionFactory", () => {
  const models = [
    { provider: "anthropic", model: "claude-opus-4" },
    { provider: "openai", model: "gpt-5" },
  ];

  function makeCurrent() {
    return {
      getSuggestions: vi.fn().mockResolvedValue(null),
      applyCompletion: vi.fn(),
    };
  }

  function suggestionsFor(
    provider: ReturnType<typeof makeCurrent>,
    typed: string,
  ) {
    const wrapped = createBangModelCompletionFactory(() => models)(provider);
    return wrapped.getSuggestions([typed], 0, typed.length, {
      signal: new AbortController().signal,
    });
  }

  it("offers models with the dollar prefix retained in values", async () => {
    const provider = makeCurrent();
    const result = await suggestionsFor(provider, "$op");
    expect(result?.prefix).toBe("$op");
    expect(result?.items[0].value).toBe("$anthropic/claude-opus-4");
    expect(provider.getSuggestions).not.toHaveBeenCalled();
  });

  it("keeps two and three dollar prefixes intact", async () => {
    await expect(suggestionsFor(makeCurrent(), "$$gpt")).resolves.toMatchObject(
      {
        items: [{ value: "$$openai/gpt-5" }],
      },
    );
    await expect(
      suggestionsFor(makeCurrent(), "$$$gpt"),
    ).resolves.toMatchObject({
      items: [{ value: "$$$openai/gpt-5" }],
    });
  });

  it("falls through to the wrapped provider for other text", async () => {
    const provider = makeCurrent();
    const result = await suggestionsFor(provider, "plain message");
    expect(result).toBeNull();
    expect(provider.getSuggestions).toHaveBeenCalled();
  });

  it("declares $ as a trigger character so the editor opens the popup", () => {
    const wrapped = createBangModelCompletionFactory(() => models)(
      makeCurrent(),
    );
    expect(wrapped.triggerCharacters).toEqual(["$"]);
  });

  it("suppresses completions once the prompt has started", async () => {
    expect(
      await suggestionsFor(makeCurrent(), "$opus-4 write a haiku"),
    ).toBeNull();
  });
});
