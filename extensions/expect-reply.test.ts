import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import expectReplyExtension from "./index";
import * as messaging from "../src/utils/messaging";
import * as registry from "../src/utils/registry";
import { AgentKind, type AgentRecord, type TeamMessage } from "../src/utils/models";
import {
  MAX_REMINDERS,
  NO_REPLY_SUBJECT_PREFIX,
  ObligationTracker,
  REMINDER_CUSTOM_TYPE,
} from "../src/utils/obligations";
import { RecipientUnreachableError, sendToAgent } from "../src/utils/transport";

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
  supportsWindows: () => false,
}));

const lead: AgentRecord = {
  id: "erlead01",
  kind: AgentKind.Lead,
  cwd: "/tmp/expect-reply-lead",
  pid: 1,
  startedAt: 1,
};
const peer: AgentRecord = {
  id: "erpeer01",
  kind: AgentKind.Lead,
  cwd: "/tmp/expect-reply-peer",
  pid: 2,
  startedAt: 2,
};
const peer2: AgentRecord = {
  id: "erpeer02",
  kind: AgentKind.Lead,
  cwd: "/tmp/expect-reply-peer2",
  pid: 3,
  startedAt: 3,
};
const records = [lead, peer, peer2];
// Workers owned by `lead`. Their pid is the test process so the run-hold liveness check sees them alive.
const worker1: AgentRecord = {
  id: "erwork01",
  kind: AgentKind.Teammate,
  cwd: "/tmp/expect-reply-worker1",
  pid: process.pid,
  leadId: lead.id,
  name: "alice",
  startedAt: 4,
};
const worker2: AgentRecord = {
  ...worker1,
  id: "erwork02",
  cwd: "/tmp/expect-reply-worker2",
  name: "bob",
  startedAt: 5,
};
const teamRecords = [...records, worker1, worker2];
// Captured before any spy so tests can let outbound messages travel over the real transport.
const realSendAgentMessage = messaging.sendAgentMessage;

/** Replace the registry reads with an in-memory record list. */
function mockRegistry(recs: AgentRecord[]): void {
  vi.spyOn(registry, "ensureRegistryDir").mockImplementation(() => {});
  vi.spyOn(registry, "writeAgentRecord").mockImplementation(() => {});
  vi.spyOn(registry, "readAgentRecord").mockImplementation((id) => recs.find((record) => record.id === id));
  vi.spyOn(registry, "readAgentRecords").mockReturnValue(recs);
}

/** Handler stored by the loadLead `on` mock; boundary handlers return values. */
type Handler = (...args: any[]) => Promise<unknown>;

function loadLead() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
  };
  expectReplyExtension(pi as any);
  return { handlers, tools, pi: pi as any };
}

function inbound(
  subject: string,
  expectReply?: boolean,
  sender: AgentRecord = peer,
  recipient: AgentRecord = lead,
): TeamMessage {
  return {
    id: `msg-${sender.id}-${subject}`,
    from: sender.id,
    to: recipient.id,
    fromLabel: messaging.agentLabel(sender),
    subject,
    text: "Peer request",
    timestamp: new Date().toISOString(),
    ...(expectReply === undefined ? {} : { expectReply }),
  };
}

describe("expectReply obligations", () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let recordSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "lead");
    vi.stubEnv("PI_AGENT_ID", lead.id);
    vi.stubEnv("PI_LEAD_ID", "");
    mockRegistry(records);
    sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(peer);
    recordSpy = vi.spyOn(ObligationTracker.prototype, "record");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** The session's tracker, captured from the instance that `record` or `clear` ran on. */
  function tracker(): ObligationTracker {
    const instance = recordSpy.mock.contexts[0] as ObligationTracker | undefined;
    if (!instance) throw new Error("No obligation was recorded in this test.");
    return instance;
  }

  async function start(handlers: Map<string, Handler>, hasUI = true): Promise<void> {
    await handlers.get("session_start")?.({}, {
      ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() },
      hasUI,
      model: { provider: "test", id: "model" },
    });
  }

  async function reply(tools: Map<string, any>): Promise<void> {
    await tools.get("send_message").execute("call", {
      recipient: peer.id,
      subject: "Answer",
      content: "Done.",
      expectReply: false,
    });
  }

  it("records one obligation for an expectReply:true message", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    expect(tracker().pending()).toEqual([
      { senderId: peer.id, senderLabel: messaging.agentLabel(peer), subject: "Question", reminders: 0 },
    ]);
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("records nothing for expectReply:false or absent", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Explicit false", false));
    await sendToAgent(inbound("Absent"));
    expect(recordSpy).not.toHaveBeenCalled();
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("clears the obligation when send_message reaches that sender", async () => {
    const { handlers, tools } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    await reply(tools);
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(tracker().pending()).toEqual([]);
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("clears the obligation when the sender is unreachable", async () => {
    const { handlers, tools } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    sendSpy.mockRejectedValue(new RecipientUnreachableError(peer.id));
    await expect(reply(tools)).rejects.toBeInstanceOf(RecipientUnreachableError);
    expect(tracker().pending()).toEqual([]);
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("keeps the obligation when the send fails for another reason", async () => {
    const { handlers, tools } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    sendSpy.mockRejectedValue(new Error("boom"));
    await expect(reply(tools)).rejects.toThrow("boom");
    expect(tracker().pending()).toHaveLength(1);
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("replaces the subject on a second expectReply:true from the same sender", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("First", true));
    await sendToAgent(inbound("Second", true));
    expect(tracker().pending().map((obligation) => obligation.subject)).toEqual(["Second"]);
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("empties the tracker at session_shutdown", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    await handlers.get("session_shutdown")?.({}, {});
    expect(tracker().pending()).toEqual([]);
  });

  // ── Reminder injection at agent_before_settle ──────────────────────────
  // The handler is driven directly with synthetic boundary events, matching
  // how pi dispatches BoundaryState at the settle boundary.

  /** Shape of a synthetic agent_before_settle event, per BoundaryState. */
  function boundary(options: { outcome?: string; canContinue?: boolean; entries?: any[] } = {}): any {
    const { outcome = "completed", canContinue = true, entries = [] } = options;
    return {
      type: "agent_before_settle",
      entries,
      continue: false,
      outcome,
      context: { canContinue, contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [] },
    };
  }

  /** Run the registered agent_before_settle handler on one boundary event. */
  async function settleOnce(
    handlers: Map<string, Handler>,
    options: Parameters<typeof boundary>[0] = {},
  ): Promise<any> {
    const result = await handlers.get("agent_before_settle")?.(boundary(options), {});
    return result ?? undefined;
  }

  it("injects one reminder entry and continues when a reply is owed", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    const result = await settleOnce(handlers);
    expect(result).toBeDefined();
    expect(result.continue).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      type: "custom_message",
      customType: REMINDER_CUSTOM_TYPE,
      display: true,
    });
    expect(result.entries[0].content).toContain(peer.id);
    expect(tracker().pending()[0].reminders).toBe(1);
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("keeps existing entries, in order, ahead of the reminder", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    const marker = { type: "custom", customType: "test-marker", data: 1 };
    const queued = { type: "custom_message", customType: "queued-notice", content: "x", display: true };
    const result = await settleOnce(handlers, { entries: [marker, queued] });
    expect(result).toEqual({
      entries: [marker, queued, expect.objectContaining({ customType: REMINDER_CUSTOM_TYPE })],
      continue: true,
    });
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("stops after MAX_REMINDERS boundaries for the same obligation", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    for (let i = 0; i < MAX_REMINDERS; i++) {
      const result = await settleOnce(handlers);
      expect(result?.continue).toBe(true);
      expect(result?.entries.at(-1).customType).toBe(REMINDER_CUSTOM_TYPE);
    }
    expect(tracker().pending()[0].reminders).toBe(MAX_REMINDERS);
    expect(await settleOnce(handlers)).toBeUndefined();
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("spends no reminder on aborted, error, or non-continuable boundaries", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    const unwelcome: Parameters<typeof boundary>[0][] = [
      { outcome: "aborted" },
      { outcome: "error" },
      { canContinue: false },
    ];
    for (const options of unwelcome) {
      expect(await settleOnce(handlers, options)).toBeUndefined();
    }
    expect(tracker().pending()[0].reminders).toBe(0);
    // A completable boundary afterwards still gets its full reminder budget.
    expect((await settleOnce(handlers)).entries).toHaveLength(1);
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("names every owed sender in one reminder entry", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    await sendToAgent(inbound("Second question", true, peer2));
    const result = await settleOnce(handlers);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content.split("\n")).toHaveLength(2);
    expect(result.entries[0].content).toContain(peer.id);
    expect(result.entries[0].content).toContain(peer2.id);
    expect(tracker().pending().map((obligation) => obligation.reminders)).toEqual([1, 1]);
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("returns nothing when no reply is owed", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    expect(await settleOnce(handlers)).toBeUndefined();
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("stops reminding after send_message answers the sender", async () => {
    const { handlers, tools } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    expect((await settleOnce(handlers)).continue).toBe(true);
    await reply(tools);
    expect(await settleOnce(handlers)).toBeUndefined();
    await handlers.get("session_shutdown")?.({}, {});
  });

  // ── agent_settled notice handler ───────────────────────────────────────
  // The handler is registered twice in extensions/index.ts: the first call
  // publishes idle run state, the second walks pending obligations and sends
  // a notice to each waiting sender. The harness stores handlers by name, so
  // calling `handlers.get("agent_settled")` invokes the second (last) one.

  /** Run the registered agent_settled handler once. */
  async function settleCompletely(
    handlers: Map<string, Handler>,
    options: { aborted?: boolean } = {},
  ): Promise<void> {
    await handlers.get("agent_settled")?.({ aborted: options.aborted ?? false });
  }

  // session_start builds selfRecord from process.cwd() and the live pid, so
  // the label cannot reuse the static `lead` fixture's cwd.
  const selfLabel = `Pi Agent in ${process.cwd()}`;

  it("sends a No reply notice after MAX_REMINDERS reminders and clears the obligation", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    for (let i = 0; i < MAX_REMINDERS; i++) {
      await settleOnce(handlers);
    }
    expect(tracker().pending()[0].reminders).toBe(MAX_REMINDERS);
    sendSpy.mockClear();

    await settleCompletely(handlers);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: lead.id, kind: AgentKind.Lead }),
      peer.id,
      `No reply from ${selfLabel}`,
      `${selfLabel} did not reply to "Question" after ${MAX_REMINDERS} reminders.`,
      false,
    );
    expect(tracker().pending()).toEqual([]);
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("sends one Interrupted notice per pending obligation and keeps them pending", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    await sendToAgent(inbound("Second question", true, peer2));
    sendSpy.mockClear();

    await settleCompletely(handlers, { aborted: true });

    expect(sendSpy).toHaveBeenCalledTimes(2);
    const recipients = sendSpy.mock.calls.map((call: unknown[]) => call[1]).sort();
    expect(recipients).toEqual([peer.id, peer2.id].sort());
    for (const call of sendSpy.mock.calls) {
      expect(call[2]).toBe(`Interrupted: ${selfLabel}`);
      expect(call[3]).toMatch(/^.+ was interrupted before replying to ".+"\.$/);
      expect(call[4]).toBe(false);
    }
    const pending = tracker().pending();
    expect(pending.map((obligation) => obligation.senderId).sort()).toEqual([peer.id, peer2.id].sort());
    expect(pending.every((obligation) => obligation.reminders === 0)).toBe(true);
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("sends nothing on a clean settle with no obligations", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    sendSpy.mockClear();

    await settleCompletely(handlers);

    expect(sendSpy).not.toHaveBeenCalled();
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("keeps an obligation that has not reached the cap", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("Question", true));
    await settleOnce(handlers);
    expect(tracker().pending()[0].reminders).toBe(1);
    sendSpy.mockClear();

    await settleCompletely(handlers);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(tracker().pending()).toHaveLength(1);
    expect(tracker().pending()[0].reminders).toBe(1);
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("swallows a send failure for one notice and continues to the next", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await sendToAgent(inbound("First", true));
    await sendToAgent(inbound("Second", true, peer2));
    for (let i = 0; i < MAX_REMINDERS; i++) {
      await settleOnce(handlers);
    }
    // pending() returns every obligation still tracked; takeExpired() (called
    // by the settle handler) is what removes the ones at the cap. So both
    // obligations are still listed, each with reminders === MAX_REMINDERS.
    expect(tracker().pending().map((obligation) => obligation.reminders)).toEqual([
      MAX_REMINDERS,
      MAX_REMINDERS,
    ]);
    sendSpy.mockClear();
    const recipientsInOrder = [peer.id, peer2.id];
    sendSpy.mockImplementation(async (_sender: AgentRecord, recipient: string) => {
      if (recipient === recipientsInOrder[0]) throw new Error("recipient down");
      return peer2;
    });

    await expect(settleCompletely(handlers)).resolves.toBeUndefined();

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls.map((call: unknown[]) => call[1])).toEqual(recipientsInOrder);
    await handlers.get("session_shutdown")?.({}, {});
  });
});

// ── End-to-end scenarios ─────────────────────────────────────────────────
// Each scenario loads real extension instances. Inbound messages travel over
// the real Unix socket transport (`sendToAgent`) into `receiveTeamMessage`,
// and the lifecycle handlers run as Pi would call them. Only the registry and
// the outbound `sendAgentMessage` are mocked, unless a scenario needs two
// instances to talk to each other.

describe("expectReply end-to-end scenarios", () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let recordSpy: ReturnType<typeof vi.spyOn>;
  /** Handlers of every instance loaded by the running test, closed in afterEach. */
  const loaded: Map<string, Handler>[] = [];

  beforeEach(() => {
    mockRegistry(teamRecords);
    sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(lead);
    recordSpy = vi.spyOn(ObligationTracker.prototype, "record");
  });

  afterEach(async () => {
    for (const handlers of loaded.splice(0)) await handlers.get("session_shutdown")?.({}, {});
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /**
   * Load one extension instance with the identity of the given record and run its session_start.
   * The extension reads its identity from the environment at load time, so the env is stubbed first.
   */
  async function boot(record: AgentRecord, hasUI = true) {
    vi.stubEnv("PI_AGENT_ID", record.id);
    vi.stubEnv("PI_AGENT_TYPE", record.kind);
    vi.stubEnv("PI_AGENT_NAME", record.name ?? "");
    vi.stubEnv("PI_LEAD_ID", record.leadId ?? "");
    const instance = loadLead();
    loaded.push(instance.handlers);
    await instance.handlers.get("session_start")?.({}, {
      ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() },
      hasUI,
      model: { provider: "test", id: "model" },
    });
    return instance;
  }

  /** Run agent_before_settle on a completed run that can continue. */
  async function beforeSettle(handlers: Map<string, Handler>): Promise<any> {
    const event = {
      type: "agent_before_settle",
      entries: [],
      continue: false,
      outcome: "completed",
      context: { canContinue: true, contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [] },
    };
    return (await handlers.get("agent_before_settle")?.(event, {})) ?? undefined;
  }

  /** Run agent_settled for a clean (not aborted) settle. */
  async function settle(handlers: Map<string, Handler>): Promise<void> {
    await handlers.get("agent_settled")?.({ aborted: false });
  }

  // session_start builds selfRecord from process.cwd(), so labels use it.
  const workerLabel = `Worker alice in ${process.cwd()}`;

  it("reminds a silent worker three times, then sends one No reply notice to the lead", async () => {
    const { handlers } = await boot(worker1);
    await sendToAgent(inbound("Task", true, lead, worker1));

    for (let i = 0; i < MAX_REMINDERS; i++) {
      const result = await beforeSettle(handlers);
      expect(result.continue).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].customType).toBe(REMINDER_CUSTOM_TYPE);
      expect(result.entries[0].content).toContain(lead.id);
    }
    expect(await beforeSettle(handlers)).toBeUndefined();
    expect(sendSpy).not.toHaveBeenCalled();

    await settle(handlers);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: worker1.id }),
      lead.id,
      `No reply from ${workerLabel}`,
      `${workerLabel} did not reply to "Task" after ${MAX_REMINDERS} reminders.`,
      false,
    );

    await settle(handlers);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("stops reminding and sends no notice after the worker messages the lead", async () => {
    const { handlers, tools } = await boot(worker1);
    await sendToAgent(inbound("Task", true, lead, worker1));
    expect((await beforeSettle(handlers)).continue).toBe(true);

    await tools.get("send_message").execute("call", {
      recipient: "lead",
      subject: "Done",
      content: "Finished the task.",
      expectReply: false,
    });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: worker1.id }),
      "lead",
      "Done",
      "Finished the task.",
      false,
      undefined,
      expect.anything(),
    );
    sendSpy.mockClear();

    expect(await beforeSettle(handlers)).toBeUndefined();
    await settle(handlers);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("ends a two-lead exchange after the reply: expectReply:false creates no obligation", async () => {
    // Let outbound messages from both leads travel over the real sockets.
    sendSpy.mockImplementation(realSendAgentMessage);
    const leadA = await boot(lead);
    const leadB = await boot(peer);

    await leadA.tools.get("send_message").execute("call", {
      recipient: peer.id,
      subject: "Question",
      content: "Status?",
      expectReply: true,
    });
    // Only B recorded an obligation, and it is owed to A.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(lead.id, expect.stringContaining("Pi Agent in"), "Question");
    const trackerB = recordSpy.mock.contexts[0] as ObligationTracker;
    expect(trackerB.pending().map((obligation) => obligation.senderId)).toEqual([lead.id]);
    expect(await beforeSettle(leadA.handlers)).toBeUndefined();

    await leadB.tools.get("send_message").execute("call", {
      recipient: lead.id,
      subject: "Answer",
      content: "All good.",
      expectReply: false,
    });
    expect(trackerB.pending()).toEqual([]);
    expect(await beforeSettle(leadB.handlers)).toBeUndefined();
    await settle(leadB.handlers);

    // A received the reply, recorded nothing, and has nothing to remind or notify.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(leadA.pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Reply expected: no."),
      { deliverAs: "followUp" },
    );
    expect(await beforeSettle(leadA.handlers)).toBeUndefined();
    await settle(leadA.handlers);
    // Outbound calls: A's question and B's answer only. No notice from either side.
    expect(sendSpy.mock.calls.map((call: unknown[]) => call[2])).toEqual(["Question", "Answer"]);
  });

  it("makes each worker owe a reply after a broadcast with expectReply:true", async () => {
    const workerA = await boot(worker1);
    const workerB = await boot(worker2);
    const leadInstance = await boot(lead);

    const result = await leadInstance.tools.get("send_message").execute("call", {
      recipient: "all",
      subject: "Status round",
      content: "Report your status.",
      expectReply: true,
    });
    expect(result.details.delivered.map((record: AgentRecord) => record.id).sort()).toEqual(
      [worker1.id, worker2.id].sort(),
    );
    expect(result.details.failed).toEqual([]);

    // One obligation per worker, each owed to the lead. The lead owes nothing.
    expect(recordSpy).toHaveBeenCalledTimes(2);
    for (const call of recordSpy.mock.calls) {
      expect(call).toEqual([lead.id, expect.stringContaining("Pi Agent in"), "Status round"]);
    }
    expect(new Set(recordSpy.mock.contexts).size).toBe(2);
    for (const { handlers } of [workerA, workerB]) {
      const reminder = await beforeSettle(handlers);
      expect(reminder.continue).toBe(true);
      expect(reminder.entries[0].content).toContain(lead.id);
    }
    expect(await beforeSettle(leadInstance.handlers)).toBeUndefined();
  });

  it("releases the non-interactive run hold when the worker's No reply notice arrives", async () => {
    // A full hold is practical here: the loop re-checks the follow-up epoch every
    // RUN_HOLD_MESSAGE_POLL_MS (1 s). Fake timers would also freeze the socket
    // transport's own timeouts, so this test waits in real time, bounded by the
    // test timeout. The worker pid is this process, so the liveness check passes.
    const { handlers, pi } = await boot(lead, false);

    let released = false;
    const hold = handlers.get("agent_end")?.({}, { hasUI: false })?.then(() => {
      released = true;
    });
    const stillParked = await Promise.race([
      hold,
      new Promise<string>((resolve) => setTimeout(() => resolve("parked"), 100)),
    ]);
    expect(stillParked).toBe("parked");
    expect(released).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    await sendToAgent(
      inbound(`${NO_REPLY_SUBJECT_PREFIX} ${workerLabel}`, false, worker1),
    );

    await hold;
    expect(released).toBe(true);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(`${NO_REPLY_SUBJECT_PREFIX} ${workerLabel}`),
      { deliverAs: "followUp" },
    );
  }, 5000);

  it("does not hold an interactive lead: agent_end returns at once when hasUI is true", async () => {
    const { handlers } = await boot(lead, true);
    await expect(handlers.get("agent_end")?.({}, { hasUI: true })).resolves.toBeUndefined();
  });
});
