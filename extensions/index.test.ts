import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  getTopModelMatches,
  clearModelsCache,
  resolveModelWithProvider,
  formatDeliveredMessages,
  FollowUpMessageQueue,
  mergeQueuedMessages,
} from "./index";
import type { InboxMessage } from "../src/utils/models";

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
    );
    expect(resolved).toBe("bighank/qwen3coder-35b");
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
