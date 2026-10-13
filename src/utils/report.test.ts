import { describe, expect, it } from "vitest";
import {
  ABORTED_REPORT_TEXT,
  CLOSED_REPORT_NOTE,
  EMPTY_REPORT_TEXT,
  MAX_REPORT_REPLIES,
  REPORT_SUBJECT_PREFIX,
  appendReply,
  buildClosingReport,
  buildWorkerReport,
  extractFinalReply,
} from "./report";

const assistant = (...blocks: unknown[]) => ({ role: "assistant", content: blocks });
const text = (value: string) => ({ type: "text", text: value });
const toolCall = { type: "toolCall", name: "read" };

describe("extractFinalReply", () => {
  it("returns null for an empty run", () => {
    expect(extractFinalReply([])).toBeNull();
  });

  it("returns the text of the newest assistant message", () => {
    const messages = [assistant(text("first")), { role: "user", content: "next" }, assistant(text("second"))];
    expect(extractFinalReply(messages)).toBe("second");
  });

  it("skips assistant messages that only contain tool calls", () => {
    const messages = [assistant(text("the results")), assistant(toolCall)];
    expect(extractFinalReply(messages)).toBe("the results");
  });

  it("joins multiple text blocks with a newline", () => {
    expect(extractFinalReply([assistant(text("a"), toolCall, text("b"))])).toBe("a\nb");
  });

  it("accepts string content", () => {
    expect(extractFinalReply([{ role: "assistant", content: "  plain  " }])).toBe("plain");
  });

  it("ignores user and tool result messages", () => {
    const messages = [{ role: "user", content: "hi" }, { role: "toolResult", content: [text("out")] }];
    expect(extractFinalReply(messages)).toBeNull();
  });

  it("tolerates malformed entries", () => {
    expect(extractFinalReply([null, undefined, 42, { role: "assistant" }])).toBeNull();
  });
});

describe("appendReply", () => {
  it("adds a reply to the end", () => {
    expect(appendReply(["a"], "b")).toEqual(["a", "b"]);
  });

  it("ignores a run without text", () => {
    expect(appendReply(["a"], null)).toEqual(["a"]);
  });

  it("does not change the input list", () => {
    const replies = ["a"];
    appendReply(replies, "b");
    expect(replies).toEqual(["a"]);
  });

  it("drops the oldest replies past the cap", () => {
    let replies: string[] = [];
    for (let i = 0; i < MAX_REPORT_REPLIES + 5; i++) replies = appendReply(replies, `r${i}`);
    expect(replies).toHaveLength(MAX_REPORT_REPLIES);
    expect(replies[0]).toBe("r5");
    expect(replies[replies.length - 1]).toBe(`r${MAX_REPORT_REPLIES + 4}`);
  });
});

describe("buildWorkerReport", () => {
  it("sends the full reply of a single run unchanged", () => {
    const report = buildWorkerReport("alice", ["All done."], false);
    expect(report).toEqual({ subject: `${REPORT_SUBJECT_PREFIX} alice`, text: "All done." });
  });

  it("numbers every reply when several runs settled together", () => {
    const report = buildWorkerReport("alice", ["W1 DONE", "Got the peer note."], false);
    expect(report.text).toContain("Reply 1 of 2:\n\nW1 DONE");
    expect(report.text).toContain("Reply 2 of 2:\n\nGot the peer note.");
    expect(report.text.indexOf("W1 DONE")).toBeLessThan(report.text.indexOf("Got the peer note."));
  });

  it("explains an empty finished run", () => {
    expect(buildWorkerReport("alice", [], false).text).toBe(EMPTY_REPORT_TEXT);
  });

  it("reports an interruption without replies", () => {
    expect(buildWorkerReport("alice", [], true).text).toBe(ABORTED_REPORT_TEXT);
  });

  it("includes the replies in an interruption report", () => {
    const report = buildWorkerReport("alice", ["Half way."], true);
    expect(report.text).toContain(ABORTED_REPORT_TEXT);
    expect(report.text).toContain("Half way.");
  });
});

describe("buildClosingReport", () => {
  it("appends the closing note to the replies", () => {
    const report = buildClosingReport("alice", ["Wrote the file."]);
    expect(report.subject).toBe(`${REPORT_SUBJECT_PREFIX} alice`);
    expect(report.text).toBe(`Wrote the file.\n\n${CLOSED_REPORT_NOTE}`);
  });

  it("numbers several replies before the closing note", () => {
    const report = buildClosingReport("alice", ["one", "two"]);
    expect(report.text).toContain("Reply 2 of 2:\n\ntwo");
    expect(report.text.endsWith(CLOSED_REPORT_NOTE)).toBe(true);
  });

  it("sends only the closing note when the worker had no replies", () => {
    expect(buildClosingReport("alice", []).text).toBe(CLOSED_REPORT_NOTE);
  });
});
