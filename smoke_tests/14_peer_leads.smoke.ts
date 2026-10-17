// CLAIM S14: two leads in different directories are visible and can message each other.
import { describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatAgentLine, sortAgentLines } from "../src/utils/agentFormat";
import { broadcastAgentMessage, sendAgentMessage } from "../src/utils/messaging";
import { AgentKind, AgentStatus, type TeamMessage } from "../src/utils/models";
import { pruneAndList, readAgentRecord, removeAgentRecord } from "../src/utils/registry";
import { visibleTo } from "../src/utils/visibility";

const CHILD_SOURCE = path.resolve(__dirname, "helpers/agent_child.ts");
const ESBUILD = path.resolve(__dirname, "../node_modules/.bin/esbuild");
const ID_A = "s14lead1";
const ID_B = "s14lead2";

function bundleChild(dir: string): string {
  const bundle = path.join(dir, "agent_child.mjs");
  execFileSync(ESBUILD, [CHILD_SOURCE, "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`], {
    stdio: "pipe",
  });
  return bundle;
}

function waitForLine(child: ChildProcess, predicate: (line: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const lines = output.split("\n");
      output = lines.pop() ?? "";
      for (const line of lines) {
        if (predicate(line)) {
          cleanup();
          resolve(line);
        }
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Agent child exited before expected output (code ${code})`));
    };
    const cleanup = (): void => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.on("exit", onExit);
  });
}

describe("S14 peer leads", () => {
  it("lists two leads, sends across processes, and prunes a killed lead", async () => {
    const previousTmpDir = process.env.TMPDIR;
    const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "s"));
    process.env.TMPDIR = registryRoot;
    const cwdA = fs.mkdtempSync(path.join(registryRoot, "a"));
    const cwdB = fs.mkdtempSync(path.join(registryRoot, "b"));
    const bundle = bundleChild(registryRoot);
    const children: ChildProcess[] = [];
    try {
      const childA = spawn(process.execPath, [bundle, ID_A, AgentKind.Lead, cwdA], { stdio: ["ignore", "pipe", "inherit"] });
      const childB = spawn(process.execPath, [bundle, ID_B, AgentKind.Lead, cwdB], { stdio: ["ignore", "pipe", "inherit"] });
      children.push(childA, childB);
      const readyA = waitForLine(childA, (line) => line.includes('"ready":true'));
      const readyB = waitForLine(childB, (line) => line.includes('"ready":true'));
      await Promise.all([readyA, readyB]);

      const leadA = readAgentRecord(ID_A);
      expect(leadA).toBeDefined();
      const viewer = leadA!;
      const online = await pruneAndList();
      const visible = visibleTo(viewer, online.map((entry) => entry.record));
      const displayed = sortAgentLines(online.filter((entry) => visible.some((record) => record.id === entry.record.id)))
        .map((entry) => formatAgentLine(entry.record, entry.status, viewer.id));
      expect(displayed).toContain(`Pi Agent in ${cwdA}: ${ID_A}: Online (you)`);
      expect(displayed).toContain(`Pi Agent in ${cwdB}: ${ID_B}: Online`);

      const messageLine = waitForLine(childB, (line) => line.includes('"text":"hello from lead A"'));
      await sendAgentMessage(viewer, ID_B, "Peer greeting", "hello from lead A", false, undefined, online.map((entry) => entry.record));
      const message = JSON.parse(await messageLine) as TeamMessage;
      expect(message.from).toBe(ID_A);
      expect(message.fromLabel).toBe(`Pi Agent in ${cwdA}`);
      expect(message.to).toBe(ID_B);

      // Lead broadcasts are scoped to their own workers. Peer leads are not targets.
      const broadcast = await broadcastAgentMessage(viewer, "Peer broadcast", "local only", false, undefined, online.map((entry) => entry.record));
      expect(broadcast.delivered).toEqual([]);
      expect(broadcast.failed).toEqual([]);

      childB.kill("SIGTERM");
      await new Promise<void>((resolve, reject) => {
        if (childB.exitCode !== null) return resolve();
        childB.once("exit", () => resolve());
        childB.once("error", reject);
      });
      const afterExit = await pruneAndList();
      const offline = afterExit.filter((entry) => entry.record.cwd === cwdB);
      expect(offline).toHaveLength(1);
      expect(offline[0].status).toBe(AgentStatus.Offline);
      const offlineLine = formatAgentLine(offline[0].record, offline[0].status, viewer.id);
      expect(offlineLine).toContain(`Pi Agent in ${cwdB}: ${ID_B}: Offline`);
      await expect(
        sendAgentMessage(viewer, ID_B, "After exit", "unreachable", false, undefined, afterExit.map((entry) => entry.record)),
      ).rejects.toThrow(/spawn_team_lead/);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      removeAgentRecord(ID_A);
      removeAgentRecord(ID_B);
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
      fs.rmSync(registryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
