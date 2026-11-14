import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, run } from "./cli";
import { AgentKind, type AgentRecord, type TeamMessage } from "./utils/models";
import { writeAgentRecord } from "./utils/registry";
import { isAgentBusy } from "./utils/runstate";
import { MessageListener, sendToAgent, startListener } from "./utils/transport";
import { packageVersion, versionFilePath, writeVersionFile } from "./utils/version";

const ROOT = path.resolve(__dirname, "..");

/** Two real directories: the registry trims records whose cwd does not exist. */
let A = "";
let B = "";

function lead(id: string, cwd = A, extra: Partial<AgentRecord> = {}): AgentRecord {
  return { id, kind: AgentKind.Lead, cwd, pid: process.pid, startedAt: 1, ...extra };
}

describe("pi-teams CLI (in process)", () => {
  let dir: string;
  let originalRegistry: string | undefined;
  let stdout: string;
  let stderr: string;
  let listeners: MessageListener[];

  /** Run one command, capturing what it prints. */
  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    stdout = "";
    stderr = "";
    const code = await run(argv);
    return { code, out: stdout, err: stderr };
  }

  /** Register a lead record and a live listener for it. */
  async function onlineLead(rec: AgentRecord): Promise<TeamMessage[]> {
    writeAgentRecord(rec);
    const received: TeamMessage[] = [];
    listeners.push(await startListener(rec.id, (m) => void received.push(m)));
    return received;
  }

  beforeEach(() => {
    originalRegistry = process.env.PI_TEAMS_REGISTRY_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "c"));
    A = fs.mkdtempSync(path.join(os.tmpdir(), "A"));
    B = fs.mkdtempSync(path.join(os.tmpdir(), "B"));
    process.env.PI_TEAMS_REGISTRY_DIR = dir;
    writeVersionFile();
    listeners = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      stderr += chunk;
      return true;
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(listeners.map((l) => l.close()));
    process.env.PI_TEAMS_REGISTRY_DIR = originalRegistry;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(A, { recursive: true, force: true });
    fs.rmSync(B, { recursive: true, force: true });
  });

  describe("version gate", () => {
    it("prints the version and protocol without needing the version file", async () => {
      fs.rmSync(versionFilePath());
      const { code, out } = await cli("version");
      expect(code).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        version: packageVersion(),
        protocol: PROTOCOL_VERSION,
        versionCheck: { ok: false },
      });
    });

    it("fails every other command with exit 3 when the version file is missing", async () => {
      fs.rmSync(versionFilePath());
      const { code, err } = await cli("models");
      expect(code).toBe(3);
      expect(err).toContain("is missing");
    });

    it("fails with exit 3 and the upgrade command when the CLI is older", async () => {
      writeVersionFile("999.0.0");
      const { code, err } = await cli("models");
      expect(code).toBe(3);
      expect(err).toContain("npm i -g @eleqtrizit/pi-teams-cli");
    });
  });

  describe("argument errors", () => {
    it("prints usage and fails with no command", async () => {
      const { code, out } = await cli();
      expect(code).toBe(1);
      expect(out).toContain("Usage: pi-teams");
    });

    it("rejects an unknown command", async () => {
      const { code, err } = await cli("bogus");
      expect(code).toBe(1);
      expect(err).toContain('Unknown command "bogus"');
    });

    it("requires --as, and a registered lead", async () => {
      expect((await cli("list")).err).toContain("--as <agent id> is required");
      expect((await cli("list", "--as", "nobody01")).err).toContain("is not registered");
    });

    it("refuses a worker as the caller", async () => {
      writeAgentRecord({ id: "wrkeraa1", kind: AgentKind.Teammate, cwd: A, pid: 1, startedAt: 1, leadId: "leadaaaa" });
      const { code, err } = await cli("state", "--as", "wrkeraa1", "busy");
      expect(code).toBe(1);
      expect(err).toContain("is a worker, not a lead");
    });
  });

  describe("send", () => {
    it("delivers a message to a peer lead with the client label and reply flag", async () => {
      writeAgentRecord(lead("callerr1", A, { client: "Claude Code" }));
      const inbox = await onlineLead(lead("peerrrr1", B));
      const { code, out } = await cli(
        "send", "--as", "callerr1", "peerrrr1", "--subject", "hi", "--body", "hello", "--expect-reply",
      );
      expect(code).toBe(0);
      expect(JSON.parse(out).delivered).toEqual([{ id: "peerrrr1", cwd: B }]);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        from: "callerr1",
        fromLabel: `Claude Code in ${A}`,
        subject: "hi",
        text: "hello",
        expectReply: true,
      });
    });

    it("defaults expectReply to false", async () => {
      writeAgentRecord(lead("callerr1"));
      const inbox = await onlineLead(lead("peerrrr1", B));
      await cli("send", "--as", "callerr1", "peerrrr1", "--subject", "s", "--body", "b");
      expect(inbox[0].expectReply).toBe(false);
    });

    it("requires a subject, a recipient and a body", async () => {
      writeAgentRecord(lead("callerr1"));
      expect((await cli("send", "--as", "callerr1", "x", "--body", "b")).err).toContain("--subject is required");
      expect((await cli("send", "--as", "callerr1", "--subject", "s", "--body", "b")).err).toContain(
        "A recipient is required",
      );
      expect((await cli("send", "--as", "callerr1", "peerrrr1", "--subject", "s", "--body", "  ")).err).toContain(
        "body is empty",
      );
    });

    it("exits 2 when the recipient is not listening", async () => {
      writeAgentRecord(lead("callerr1"));
      writeAgentRecord(lead("peerrrr1", B));
      const { code, err } = await cli("send", "--as", "callerr1", "peerrrr1", "--subject", "s", "--body", "b");
      expect(code).toBe(2);
      expect(err).toContain("not reachable");
    });

    it("fails on an unknown recipient", async () => {
      writeAgentRecord(lead("callerr1"));
      const { code, err } = await cli("send", "--as", "callerr1", "nobody", "--subject", "s", "--body", "b");
      expect(code).toBe(1);
      expect(err).toContain('Unknown recipient "nobody"');
    });

    it("broadcasts to the caller's own workers only", async () => {
      writeAgentRecord(lead("callerr1"));
      writeAgentRecord({ id: "wrkeraa1", kind: AgentKind.Teammate, cwd: A, pid: process.pid, startedAt: 1, leadId: "callerr1", name: "alice" });
      const aliceInbox: TeamMessage[] = [];
      listeners.push(await startListener("wrkeraa1", (m) => void aliceInbox.push(m)));
      const peerInbox = await onlineLead(lead("peerrrr1", B));
      const { out } = await cli("send", "--as", "callerr1", "all", "--subject", "s", "--body", "b");
      expect(JSON.parse(out)).toEqual({ delivered: [{ id: "wrkeraa1", name: "alice" }], failed: [] });
      expect(aliceInbox).toHaveLength(1);
      expect(peerInbox).toHaveLength(0);
    });
  });

  describe("list", () => {
    it("prints text lines by default and structured entries with --json", async () => {
      await onlineLead(lead("callerr1", A, { client: "Claude Code" }));
      await onlineLead(lead("peerrrr1", B));
      const text = await cli("list", "--as", "callerr1");
      expect(text.out).toBe(
        `Claude Code in ${A}: callerr1: Idling (you)\nPi Agent in ${B}: peerrrr1: Idling\n`,
      );
      const json = JSON.parse((await cli("list", "--as", "callerr1", "--json")).out);
      expect(json.agents).toEqual([
        { id: "callerr1", kind: "lead", cwd: A, client: "Claude Code", status: "Idling", self: true },
        { id: "peerrrr1", kind: "lead", cwd: B, status: "Idling", self: false },
      ]);
    });
  });

  describe("state", () => {
    it("publishes busy and idle for list_agents", async () => {
      await onlineLead(lead("callerr1"));
      await cli("state", "--as", "callerr1", "busy");
      expect(isAgentBusy("callerr1")).toBe(true);
      await cli("state", "--as", "callerr1", "idle");
      expect(isAgentBusy("callerr1")).toBe(false);
    });

    it("rejects any other state", async () => {
      writeAgentRecord(lead("callerr1"));
      expect((await cli("state", "--as", "callerr1", "asleep")).err).toContain('"busy" or "idle"');
    });
  });

  describe("close", () => {
    it("refuses a peer lead and another lead's worker, and reports a missing worker", async () => {
      writeAgentRecord(lead("callerr1"));
      writeAgentRecord(lead("peerrrr1", B));
      writeAgentRecord({ id: "wrkerbb1", kind: AgentKind.Teammate, cwd: B, pid: 1, startedAt: 1, leadId: "peerrrr1", name: "bob" });
      expect((await cli("close", "--as", "callerr1", "peerrrr1")).err).toContain("Cannot close a peer lead");
      expect((await cli("close", "--as", "callerr1", "bob")).err).toContain("Cannot close another lead's worker");
      expect((await cli("close", "--as", "callerr1", "ghost")).err).toContain("not found among your workers");
      expect((await cli("close", "--as", "callerr1")).err).toContain("or pass --all");
    });

    it("closes one worker by name, or all of them, removing their records", async () => {
      writeAgentRecord(lead("callerr1"));
      // pid 1 is never a pi worker, so removeAgent leaves the process alone.
      for (const [id, name] of [["wrkeraa1", "alice"], ["wrkeraa2", "zoe"]]) {
        writeAgentRecord({ id, kind: AgentKind.Teammate, cwd: A, pid: 1, startedAt: 1, leadId: "callerr1", name });
      }
      const one = await cli("close", "--as", "callerr1", "alice");
      expect(JSON.parse(one.out).closed).toEqual([{ id: "wrkeraa1", name: "alice" }]);
      const all = await cli("close", "--as", "callerr1", "--all");
      expect(JSON.parse(all.out).closed).toEqual([{ id: "wrkeraa2", name: "zoe" }]);
      expect(fs.readdirSync(path.join(dir, "agents")).sort()).toEqual(["callerr1.json"]);
    });
  });

  describe("spawn", () => {
    it("requires a name and a fully qualified model", async () => {
      writeAgentRecord(lead("callerr1"));
      expect((await cli("spawn", "--as", "callerr1", "--model", "p/m")).err).toContain("--name is required");
      expect((await cli("spawn", "--as", "callerr1", "--name", "a", "--model", "bare")).err).toContain(
        "fully qualified as provider/model",
      );
      expect(
        (await cli("spawn", "--as", "callerr1", "--name", "a", "--model", "p/m", "--thinking", "max")).err,
      ).toContain("--thinking must be one of");
    });

    it("rejects an empty or doubled prompt", async () => {
      writeAgentRecord(lead("callerr1"));
      const spawn = ["spawn", "--as", "callerr1", "--name", "a", "--model", "p/m"];
      expect((await cli(...spawn, "--prompt", " ")).err).toContain("The prompt is empty");
      expect((await cli(...spawn, "--prompt", "x", "--prompt-stdin")).err).toContain("not both");
    });

    it("spawn-lead requires a folder", async () => {
      expect((await cli("spawn-lead")).err).toContain("--folder is required");
    });
  });
});

/** The compiled CLI, run as the Claude Code mod will run it. */
describe("pi-teams CLI listen (built binary)", () => {
  const BIN = path.join(ROOT, "cli/pi-teams.cjs");
  let dir: string;
  let originalRegistry: string | undefined;
  let children: ChildProcess[];

  beforeAll(() => {
    execFileSync(process.execPath, [path.join(ROOT, "scripts/build-cli.mjs")], { cwd: ROOT, stdio: "pipe" });
  }, 120_000);

  beforeEach(() => {
    originalRegistry = process.env.PI_TEAMS_REGISTRY_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "e"));
    process.env.PI_TEAMS_REGISTRY_DIR = dir; // children inherit it
    writeVersionFile();
    children = [];
  });

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    process.env.PI_TEAMS_REGISTRY_DIR = originalRegistry;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Start `pi-teams listen` and resolve with its ready line once it prints. */
  function listen(args: string[] = []): Promise<{ child: ChildProcess; ready: Record<string, unknown>; lines: string[] }> {
    const child = spawn(process.execPath, [BIN, "listen", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const lines: string[] = [];
    let buffer = "";
    return new Promise((resolve, reject) => {
      child.on("error", reject);
      child.stderr!.on("data", (d) => reject(new Error(String(d))));
      child.stdout!.on("data", (chunk) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          lines.push(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          if (lines.length === 1) resolve({ child, ready: JSON.parse(lines[0]), lines });
        }
      });
    });
  }

  const waitFor = async (predicate: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("registers as a Claude Code lead, streams inbound messages, and unregisters on SIGTERM", async () => {
    const { child, ready, lines } = await listen(["--cwd", os.tmpdir()]);
    expect(ready).toMatchObject({ type: "ready", client: "Claude Code", cwd: os.tmpdir(), adopted: [] });
    const id = ready.id as string;

    const record = JSON.parse(fs.readFileSync(path.join(dir, "agents", `${id}.json`), "utf8"));
    expect(record).toMatchObject({ kind: "lead", client: "Claude Code", pid: child.pid });

    // A peer lead (a second CLI process) messages the listener over the real socket.
    writeAgentRecord(lead("testpeer", os.tmpdir()));
    const sent = execFileSync(
      process.execPath,
      [BIN, "send", "--as", "testpeer", id, "--subject", "ping", "--body", "from a peer", "--expect-reply"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(sent).delivered).toEqual([{ id, cwd: os.tmpdir() }]);
    await waitFor(() => lines.length >= 2);
    expect(JSON.parse(lines[1])).toMatchObject({
      type: "message",
      message: { from: "testpeer", subject: "ping", text: "from a peer", expectReply: true },
    });

    child.kill("SIGTERM");
    await waitFor(() => child.exitCode !== null);
    expect(child.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, "agents", `${id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dir, "s", `${id}.sock`))).toBe(false);
  }, 30_000);

  it("rejects a message from a sender that is not registered", async () => {
    const { ready, lines } = await listen();
    // Forge a message from an id with no record; the receiver-side check refuses it.
    await expect(
      sendToAgent({
        id: "forged01", from: "ghost000", to: ready.id as string, fromLabel: "x", subject: "s",
        text: "t", timestamp: new Date().toISOString(),
      }),
    ).rejects.toThrow(/unknown or not visible/);
    expect(lines).toHaveLength(1); // only the ready line
  }, 30_000);

  it("exits on its own when its parent goes away", async () => {
    // A shell parent starts the listener, prints its pid, then exits.
    const parent = spawn("/bin/sh", ["-c", `"${process.execPath}" "${BIN}" listen --cwd "${os.tmpdir()}" & echo $!; sleep 1`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(parent);
    let out = "";
    parent.stdout!.on("data", (d) => (out += d));
    await waitFor(() => /\d+/.test(out));
    const childPid = Number(out.trim().split("\n")[0]);
    children.push({ kill: () => { try { process.kill(childPid, "SIGKILL"); } catch { /* gone */ } } } as ChildProcess);
    await waitFor(() => {
      try { process.kill(childPid, 0); return false; } catch { return true; }
    }, 10_000);
    expect(fs.readdirSync(path.join(dir, "agents"))).toEqual([]);
  }, 30_000);

  it("fails fast with exit 3 when the version file is missing", () => {
    fs.rmSync(path.join(dir, "version.txt"));
    let status = 0;
    try {
      execFileSync(process.execPath, [BIN, "listen"], { stdio: "pipe" });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(3);
  });
});
