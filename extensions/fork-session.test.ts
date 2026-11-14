import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FORK_PENDING_TOOL_RESULT,
  assertForkFits,
  buildForkAck,
  buildForkNotice,
  forkLeadSession,
} from "./fork-session";

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const IDENTITY = { workerName: "scout", leadId: "lead-1", readonlyWorker: false };

function assistant(content: any[], stopReason: "stop" | "toolUse" = "stop"): any {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function toolCall(id: string, name: string): any {
  return { type: "toolCall", id, name, arguments: {} };
}

describe("forkLeadSession", () => {
  let dir: string;
  let lead: SessionManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-fork-"));
    lead = SessionManager.create(dir, path.join(dir, "lead"));
    lead.appendMessage({ role: "user", content: "map the repo", timestamp: Date.now() });
    lead.appendMessage(assistant([{ type: "text", text: "The entry point is src/main.ts." }]));
    lead.appendMessage({ role: "user", content: "now spawn help", timestamp: Date.now() });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fork(identity = IDENTITY): any[] {
    const file = forkLeadSession(lead.getSessionFile(), dir, identity, path.join(dir, "worker"));
    return SessionManager.open(file).buildSessionContext().messages as any[];
  }

  it("copies the lead history and ends on the notice and acknowledgement", () => {
    lead.appendMessage(assistant([toolCall("call-spawn", "spawn_teammate")], "toolUse"));
    const messages = fork();
    const texts = JSON.stringify(messages);
    expect(texts).toContain("The entry point is src/main.ts.");
    const [notice, ack] = messages.slice(-2);
    expect(notice).toMatchObject({ role: "user", content: buildForkNotice(IDENTITY) });
    expect(ack).toMatchObject({
      role: "assistant",
      provider: "anthropic",
      model: "claude-test",
      stopReason: "stop",
      content: [{ type: "text", text: buildForkAck(IDENTITY) }],
    });
    expect(ack.usage.totalTokens).toBe(0);
  });

  it("closes only the tool calls that were still in flight", () => {
    lead.appendMessage(
      assistant([toolCall("call-read", "read"), toolCall("call-spawn", "spawn_teammate")], "toolUse"),
    );
    lead.appendMessage({
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      content: [{ type: "text", text: "file body" }],
      isError: false,
      timestamp: Date.now(),
    });
    const results = fork().filter((message) => message.role === "toolResult");
    expect(results.map((message) => message.toolCallId)).toEqual(["call-read", "call-spawn"]);
    expect(results[0].content[0].text).toBe("file body");
    expect(results[1]).toMatchObject({
      toolName: "spawn_teammate",
      content: [{ type: "text", text: FORK_PENDING_TOOL_RESULT }],
    });
  });

  it("leaves the lead session untouched and records it as the parent", () => {
    lead.appendMessage(assistant([toolCall("call-spawn", "spawn_teammate")], "toolUse"));
    const before = fs.readFileSync(lead.getSessionFile()!, "utf8");
    const file = forkLeadSession(lead.getSessionFile(), dir, IDENTITY, path.join(dir, "worker"));
    expect(fs.readFileSync(lead.getSessionFile()!, "utf8")).toBe(before);
    expect(file).not.toBe(lead.getSessionFile());
    expect(SessionManager.open(file).getHeader()?.parentSession).toBe(lead.getSessionFile());
  });

  it("names the worker's role in the notice", () => {
    const notice = buildForkNotice({ ...IDENTITY, readonlyWorker: true });
    expect(notice).toContain("read-only worker 'scout'");
    expect(notice).toContain("lead-1");
    expect(notice).toContain("NOT the team lead");
  });

  it("refuses a fork that fills more than half of the worker's window", () => {
    expect(() => assertForkFits(100_000, 200_000)).not.toThrow();
    expect(() => assertForkFits(100_001, 200_000)).toThrow(/100001 tokens, 50% .* 200000-token window/);
    expect(() => assertForkFits(null, 200_000)).not.toThrow();
    expect(() => assertForkFits(500_000, undefined)).not.toThrow();
  });

  it("tightens the limit to 1/N of the window for N forked workers", () => {
    expect(() => assertForkFits(100_000, 200_000, 2)).not.toThrow();
    expect(() => assertForkFits(66_000, 200_000, 3)).not.toThrow();
    expect(() => assertForkFits(67_000, 200_000, 3)).toThrow(/number 3 is 33%.*already have 2 forked/);
    expect(() => assertForkFits(50_001, 200_000, 4)).toThrow(/number 4 is 25%/);
  });

  it("rejects a lead without a saved session", () => {
    expect(() => forkLeadSession(undefined, dir, IDENTITY)).toThrow(/saved session/);
  });

  it("removes the fork when there is no assistant turn to fork from", () => {
    const workerDir = path.join(dir, "worker");
    const bare = SessionManager.create(dir, path.join(dir, "bare"));
    bare.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
    expect(() => forkLeadSession(bare.getSessionFile(), dir, IDENTITY, workerDir)).toThrow(
      /no assistant turn/,
    );
    expect(fs.readdirSync(workerDir)).toEqual([]);
  });
});
