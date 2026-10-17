// CLAIM S15: a lead is isolated from other leads' workers. A's list excludes
// B's worker; A's sends to B's worker (by id and by name) are rejected by the
// sender-side check; a forged raw socket send in B's worker's name is rejected
// by A's receiver-side check; A's broadcast reaches only its own worker.
import { describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentKind, type TeamMessage } from "../src/utils/models";
import { broadcastAgentMessage, sendAgentMessage } from "../src/utils/messaging";
import { pruneAndList, writeAgentRecord } from "../src/utils/registry";
import { sendToAgent, waitForListener } from "../src/utils/transport";
import { visibleTo } from "../src/utils/visibility";

// Isolated per-user registry. Keep TMPDIR short: socket paths have a 90-char limit.
const REGISTRY_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "s"));
process.env.TMPDIR = REGISTRY_TMP;

const CHILD_SOURCE = path.resolve(__dirname, "helpers/agent_child.ts");
const ESBUILD = path.resolve(__dirname, "../node_modules/.bin/esbuild");
const A_ID = "isoaaa01";
const B_ID = "isobbb01";
const WA_ID = "isowaa01";
const WB_ID = "isowbb01";
const WA_NAME = "walk-iso";
const WB_NAME = "wbork-iso";

/** One spawned agent child with its buffered stdout. */
interface ChildFixture {
  child: ChildProcess;
  stdout: () => string;
  closed: Promise<void>;
}

/** Message texts accepted by a child, parsed from its stdout lines. */
function receivedTexts(child: ChildFixture): string[] {
  return child
    .stdout()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((value) => typeof value.text === "string")
    .map((value) => value.text);
}

/** A raw message that bypasses sendAgentMessage's sender-side check. */
function forge(from: string, to: string, text: string): TeamMessage {
  return {
    id: randomUUID().slice(0, 8),
    from,
    to,
    fromLabel: from,
    subject: "s15",
    text,
    timestamp: new Date().toISOString(),
  };
}

describe("S15 lead isolation of workers", () => {
  it("keeps another lead's workers invisible, unreachable, and silent", async () => {
    const dirA = path.join(REGISTRY_TMP, "dirA");
    const dirB = path.join(REGISTRY_TMP, "dirB");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const bundle = path.join(REGISTRY_TMP, "agent_child.mjs");
    execFileSync(ESBUILD, [CHILD_SOURCE, "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`], { stdio: "pipe" });

    const startChild = (id: string, kind: string, cwd: string, leadId?: string, name?: string): ChildFixture => {
      const args = [bundle, id, kind, cwd, ...(leadId ? [leadId, name ?? ""] : [])];
      const child = spawn(process.execPath, args, { env: { ...process.env, AGENT_CHILD_CHECK_SENDER: "1" } });
      let out = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        out += chunk;
      });
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => process.stderr.write(chunk));
      const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
      return { child, stdout: () => out, closed };
    };

    const kids: ChildFixture[] = [];
    let leadA: ChildFixture | undefined;
    let workerA: ChildFixture | undefined;
    let workerB: ChildFixture | undefined;
    try {
      leadA = startChild(A_ID, "lead", dirA);
      workerA = startChild(WA_ID, "teammate", dirA, A_ID, WA_NAME);
      workerB = startChild(WB_ID, "teammate", dirB, B_ID, WB_NAME);
      kids.push(leadA, workerA, workerB);
      expect(await waitForListener(A_ID, 15_000)).toBe(true);
      expect(await waitForListener(WA_ID, 15_000)).toBe(true);
      expect(await waitForListener(WB_ID, 15_000)).toBe(true);

      // Lead B is only a registry record; its worker references it as its lead.
      writeAgentRecord({ id: B_ID, kind: AgentKind.Lead, cwd: dirB, pid: process.pid, startedAt: Date.now() });

      // A's list: every lead (A, B) plus its own worker; B's worker is excluded.
      const entries = await pruneAndList();
      const records = entries.map((entry) => entry.record);
      expect(records.map((r) => r.id).sort()).toEqual([A_ID, B_ID, WA_ID, WB_ID].sort());
      const recA = records.find((r) => r.id === A_ID);
      expect(recA).toBeDefined();
      const viewA = visibleTo(recA!, records).map((r) => r.id);
      expect(viewA.sort()).toEqual([A_ID, B_ID, WA_ID].sort());
      expect(viewA).not.toContain(WB_ID);

      // A worker sees only its own lead and itself: B and B's worker are invisible.
      const recWa = records.find((r) => r.id === WA_ID)!;
      const viewWa = visibleTo(recWa, records).map((r) => r.id);
      expect(viewWa.sort()).toEqual([A_ID, WA_ID].sort());
      expect(viewWa).not.toContain(WB_ID);

      // Sender-side check: A cannot address B's worker, by id or by name.
      await expect(sendAgentMessage(recA!, WB_ID, "s15", "by id", false)).rejects.toThrow(/not visible/);
      await expect(sendAgentMessage(recA!, WB_NAME, "s15", "by name", false)).rejects.toThrow(/not visible/);

      // Sender-side positive control: A reaches its own worker by id.
      await sendAgentMessage(recA!, WA_ID, "s15", "direct", false);

      // Receiver-side check: a forged raw send in B's worker's name is rejected by A.
      await sendToAgent(forge(WA_ID, A_ID, "legit"));
      await expect(sendToAgent(forge(WB_ID, A_ID, "forged"))).rejects.toThrow(/not visible/);

      // Broadcast: A reaches only its own worker.
      const result = await broadcastAgentMessage(recA!, "s15", "broadcast", false);
      expect(result.delivered.map((r) => r.id)).toEqual([WA_ID]);
      expect(result.failed).toEqual([]);
    } finally {
      for (const kid of kids) kid.child.kill("SIGTERM");
      await Promise.all(kids.map((kid) => kid.closed));
      fs.rmSync(REGISTRY_TMP, { recursive: true, force: true });
    }

    // Stdout is fully flushed after close. A accepted only the visible sender;
    // wa got the direct message and the broadcast; wb stayed silent.
    expect(receivedTexts(leadA!)).toEqual(["legit"]);
    expect(receivedTexts(workerA!)).toEqual(["direct", "broadcast"]);
    expect(receivedTexts(workerB!)).toEqual([]);
  }, 60_000);
});
