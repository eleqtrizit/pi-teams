import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import util from "node:util";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgentEntry } from "./agentFormat";
import { historyKey, readAgentHistory } from "./history";
import { AgentKind, AgentRecord, AgentStatus } from "./models";
import {
  adoptOrphanedWorkers,
  agentStatus,
  ensureRegistryDir,
  generateAgentId,
  pruneAndList,
  pruneRegistry,
  readAgentRecord,
  readAgentRecords,
  removeAgentRecord,
  updateAgentRecord,
  writeAgentRecord,
} from "./registry";
import { isPidAlive } from "./pid";
import { agentHistoryLockPath, agentHistoryPath, agentRecordPath, agentSocketPath, registryDir } from "./paths";
import { tryLock, unlock } from "fs-native-extensions";
import { __setNativeLockLoaderForTests } from "./filelock";

/**
 * Fds holding a real advisory lock on the history lock for the current test.
 *
 * Under the kernel-lock design, a planted lock file does not block anything:
 * the open-file-description lock is the only authority. Tests that need
 * contention hold a real lock on an open fd, released in afterEach.
 */
let heldLockFds: number[] = [];

/** Hold the history lock for the current test via a real exclusive advisory lock. */
function holdHistoryLock(): void {
  const fd = fs.openSync(agentHistoryLockPath(), "a+", 0o600);
  if (!tryLock(fd)) throw new Error("history lock already held");
  heldLockFds.push(fd);
}

const posixOnly = process.platform === "win32" ? it.skip : it;

function lead(id: string, cwd: string, startedAt: number): AgentRecord {
  return { id, kind: AgentKind.Lead, cwd, pid: 1, startedAt };
}

function worker(id: string, startedAt: number, kind: AgentKind = AgentKind.Teammate): AgentRecord {
  // A real directory: readAgentRecords trims records whose cwd is gone.
  return { id, kind, cwd: "/tmp", pid: 1, leadId: "aa000001", name: `w-${id}`, startedAt };
}

describe("registry", () => {
  let tmpDir: string;
  let originalRegistryDir: string | undefined;
  let dirA: string;
  let dirB: string;
  let dirC: string;

  beforeEach(() => {
    originalRegistryDir = process.env.PI_TEAMS_REGISTRY_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r"));
    process.env.PI_TEAMS_REGISTRY_DIR = tmpDir;
    // Fixture working directories: readAgentRecords trims records whose cwd is gone.
    const base = path.join(tmpDir, "cwds");
    for (const name of ["a", "b", "c"]) {
      fs.mkdirSync(path.join(base, name), { recursive: true });
    }
    dirA = path.join(base, "a");
    dirB = path.join(base, "b");
    dirC = path.join(base, "c");
  });

  afterEach(() => {
    for (const fd of heldLockFds) {
      try {
        unlock(fd);
      } catch {
        // Already released.
      }
      fs.closeSync(fd);
    }
    heldLockFds = [];
    __setNativeLockLoaderForTests();
    vi.unstubAllEnvs();
    if (originalRegistryDir !== undefined) {
      process.env.PI_TEAMS_REGISTRY_DIR = originalRegistryDir;
    } else {
      delete process.env.PI_TEAMS_REGISTRY_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("generateAgentId", () => {
    it("returns an 8-character lowercase alphanumeric id", () => {
      const id = generateAgentId(() => false);
      expect(id).toMatch(/^[a-z0-9]{8}$/);
    });

    it("retries on collision", () => {
      const existing = new Set(["abc12345"]);
      const id = generateAgentId((id) => existing.has(id));
      expect(id).not.toBe("abc12345");
      expect(id).toMatch(/^[a-z0-9]{8}$/);
    });

    it("produces mostly unique ids over many calls", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const id = generateAgentId(() => false);
        expect(id).toMatch(/^[a-z0-9]{8}$/);
        ids.add(id);
      }
      expect(ids.size).toBeGreaterThan(190);
    });
  });

  describe("ensureRegistryDir", () => {
    it("creates the registry directory with agents and s subdirectories", () => {
      ensureRegistryDir();
      const dir = registryDir();
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, "agents"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "s"))).toBe(true);
    });

    posixOnly("creates directories with mode 0700", () => {
      ensureRegistryDir();
      const dir = registryDir();
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, "agents")).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, "s")).mode & 0o777).toBe(0o700);
    });

    posixOnly("fixes permissions when group/other bits are set", () => {
      ensureRegistryDir();
      const dir = registryDir();
      fs.chmodSync(dir, 0o755);
      ensureRegistryDir();
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    });
  });

  describe("writeAgentRecord", () => {
    it("persists a record and sets mode 0600", () => {
      const rec: AgentRecord = {
        id: "ab12cd34",
        kind: AgentKind.Lead,
        cwd: "/tmp",
        pid: 1234,
        startedAt: 1000,
      };
      writeAgentRecord(rec);
      const file = agentRecordPath(rec.id);
      expect(fs.existsSync(file)).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(rec);
      if (process.platform !== "win32") {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    });

    it("does not leave temporary files behind", () => {
      const rec: AgentRecord = {
        id: "ab12cd34",
        kind: AgentKind.Lead,
        cwd: "/tmp",
        pid: 1234,
        startedAt: 1000,
      };
      writeAgentRecord(rec);
      const dir = path.join(registryDir(), "agents");
      const files = fs.readdirSync(dir);
      expect(files.every((f) => !f.startsWith("."))).toBe(true);
    });

    it("records the registration in the history with a fresh lastSeenAt stamp", () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(123_456);
      try {
        writeAgentRecord(lead("ab12cd34", dirA, 1000));
      } finally {
        clock.mockRestore();
      }
      expect(readAgentHistory()).toEqual([{ cwd: dirA, startedAt: 1000, lastSeenAt: 123_456 }]);
    });
    it("writes the record and skips the history stamp when the history lock is held", () => {
      ensureRegistryDir();
      holdHistoryLock();
      vi.stubEnv("PI_TEAMS_LOCK_WAIT_TIMEOUT_MS", "40");

      const rec = lead("ab12cd34", dirA, 1000);
      expect(() => writeAgentRecord(rec)).not.toThrow();
      // The record file is written; the history entry is left for the next
      // list pass to upsert.
      expect(readAgentRecords()).toEqual([rec]);
      expect(readAgentHistory()).toEqual([]);
    });
  });

  describe("readAgentRecords", () => {
    it("returns an empty array when no records exist", () => {
      expect(readAgentRecords()).toEqual([]);
    });

    it("skips a record whose id does not match its file name", () => {
      writeAgentRecord({ id: "ab12cd34", kind: AgentKind.Lead, cwd: "/tmp", pid: 1, startedAt: 1 });
      fs.renameSync(agentRecordPath("ab12cd34"), agentRecordPath("zz99zz99"));
      expect(readAgentRecords()).toEqual([]);
    });

    it("round-trips records", () => {
      const rec1: AgentRecord = {
        id: "ab12cd34",
        kind: AgentKind.Lead,
        cwd: "/tmp",
        pid: 1234,
        startedAt: 1000,
      };
      const rec2: AgentRecord = {
        id: "ef56gh78",
        kind: AgentKind.Teammate,
        cwd: dirA,
        pid: 5678,
        leadId: "ab12cd34",
        name: "worker",
        startedAt: 2000,
      };
      writeAgentRecord(rec1);
      writeAgentRecord(rec2);
      const records = readAgentRecords();
      expect(records).toHaveLength(2);
      expect(records).toContainEqual(rec1);
      expect(records).toContainEqual(rec2);
    });

    it("round-trips records with paneId and windowId", () => {
      const rec: AgentRecord = {
        id: "ab12cd34",
        kind: AgentKind.Teammate,
        cwd: "/tmp",
        pid: 1234,
        leadId: "lead0001",
        name: "worker",
        paneId: "pane-1",
        windowId: "win-1",
        startedAt: 1000,
      };
      writeAgentRecord(rec);
      expect(readAgentRecords()).toContainEqual(rec);
    });

    it("skips unparsable files", () => {
      ensureRegistryDir();
      const dir = path.join(registryDir(), "agents");
      fs.writeFileSync(path.join(dir, "bad.json"), "not json");
      expect(readAgentRecords()).toEqual([]);
    });

    it("skips files with invalid ids in the filename", () => {
      ensureRegistryDir();
      const dir = path.join(registryDir(), "agents");
      fs.writeFileSync(
        path.join(dir, "INVALID.json"),
        JSON.stringify({ id: "INVALID", kind: "lead", cwd: "/", pid: 1, startedAt: 1 }),
      );
      expect(readAgentRecords()).toEqual([]);
    });

    it("skips records with missing required fields", () => {
      ensureRegistryDir();
      const dir = path.join(registryDir(), "agents");
      fs.writeFileSync(path.join(dir, "aa11bb22.json"), JSON.stringify({ id: "aa11bb22", kind: "lead" }));
      expect(readAgentRecords()).toEqual([]);
    });

    it("skips records with an invalid kind", () => {
      ensureRegistryDir();
      const dir = path.join(registryDir(), "agents");
      fs.writeFileSync(
        path.join(dir, "aa11bb22.json"),
        JSON.stringify({ id: "aa11bb22", kind: "unknown", cwd: "/", pid: 1, startedAt: 1 }),
      );
      expect(readAgentRecords()).toEqual([]);
    });

    it("skips records with an invalid paneId", () => {
      ensureRegistryDir();
      const dir = path.join(registryDir(), "agents");
      fs.writeFileSync(
        path.join(dir, "aa11bb22.json"),
        JSON.stringify({ id: "aa11bb22", kind: "teammate", cwd: "/", pid: 1, leadId: "ab12cd34", paneId: 123, startedAt: 1 }),
      );
      expect(readAgentRecords()).toEqual([]);
    });

    it("skips records with an invalid windowId", () => {
      ensureRegistryDir();
      const dir = path.join(registryDir(), "agents");
      fs.writeFileSync(
        path.join(dir, "aa11bb22.json"),
        JSON.stringify({ id: "aa11bb22", kind: "teammate", cwd: "/", pid: 1, leadId: "ab12cd34", windowId: 456, startedAt: 1 }),
      );
      expect(readAgentRecords()).toEqual([]);
    });

    it("skips records with an invalid leadId", () => {
      ensureRegistryDir();
      const dir = path.join(registryDir(), "agents");
      fs.writeFileSync(
        path.join(dir, "aa11bb22.json"),
        JSON.stringify({ id: "aa11bb22", kind: "teammate", cwd: "/", pid: 1, leadId: "bad", startedAt: 1 }),
      );
      expect(readAgentRecords()).toEqual([]);
    });

    it("ignores leftover temporary files", () => {
      ensureRegistryDir();
      const dir = path.join(registryDir(), "agents");
      fs.writeFileSync(path.join(dir, ".tmp-ab12cd34-123-1.json"), "partial");
      expect(readAgentRecords()).toEqual([]);
    });

    it("trims records whose working directory no longer exists, then reloads", () => {
      const gone = path.join(tmpDir, "gone");
      fs.mkdirSync(gone);
      const stale: AgentRecord = lead("ab12cd34", gone, 100);
      const alive: AgentRecord = lead("ef56gh78", dirA, 200);
      writeAgentRecord(stale);
      writeAgentRecord(alive);
      ensureRegistryDir();
      fs.writeFileSync(agentSocketPath("ab12cd34"), "");

      fs.rmSync(gone, { recursive: true });

      expect(readAgentRecords()).toEqual([alive]);
      expect(fs.existsSync(agentRecordPath("ab12cd34"))).toBe(false);
      expect(fs.existsSync(agentSocketPath("ab12cd34"))).toBe(false);
      // The trimmed record's history entry is removed with the record.
      const entries = readAgentHistory();
      expect(entries).toHaveLength(1);
      expect(entries.every((e) => e.cwd === dirA)).toBe(true);
    });

    it("trims several stale records with one locked history mutation", () => {
      const stale: AgentRecord[] = [];
      for (const [id, name, startedAt] of [
        ["ab000001", "gone-1", 100],
        ["cd000002", "gone-2", 200],
        ["ef000003", "gone-3", 300],
      ] as const) {
        const gone = path.join(tmpDir, name);
        fs.mkdirSync(gone);
        stale.push(lead(id, gone, startedAt));
      }
      const alive = lead("99aaa999", dirA, 400);
      for (const rec of [...stale, alive]) writeAgentRecord(rec);
      for (const rec of stale) fs.rmSync(rec.cwd, { recursive: true });

      // Each history mutation is one atomic rename onto agents.jsonl.
      const renames = vi.spyOn(fs, "renameSync");
      const history = agentHistoryPath();
      let historyRenames: Array<Parameters<typeof fs.renameSync>> = [];
      try {
        expect(readAgentRecords()).toEqual([alive]);
        historyRenames = renames.mock.calls.filter((call) => call[1] === history);
      } finally {
        renames.mockRestore();
      }
      expect(historyRenames).toHaveLength(1);
      for (const rec of stale) {
        expect(fs.existsSync(agentRecordPath(rec.id))).toBe(false);
      }
      const entries = readAgentHistory();
      expect(entries).toHaveLength(1);
      expect(entries[0].cwd).toBe(dirA);
    });

    it("returns cwd-filtered records without throwing when the history lock is held", () => {
      const gone = path.join(tmpDir, "gone-lock");
      fs.mkdirSync(gone);
      const stale = lead("ab12cd34", gone, 100);
      const alive = lead("ef56gh78", dirA, 200);
      writeAgentRecord(stale);
      writeAgentRecord(alive);
      fs.rmSync(gone, { recursive: true });

      // Another process holds the history lock: a real exclusive advisory lock. No
      // env stub here, so a regression of the trim to the default 2-second
      // wait fails the timing assertion below.
      ensureRegistryDir();
      holdHistoryLock();

      // Contention must not propagate: callers like authorizeSender would
      // reject every message if it did. The zero-wait try-lock also keeps
      // the whole call fast instead of stalling the event loop.
      const startedAt = Date.now();
      expect(() => readAgentRecords()).not.toThrow();
      expect(readAgentRecords()).toEqual([alive]);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      // The trim was skipped, so the stale record survives for the next load.
      expect(fs.existsSync(agentRecordPath("ab12cd34"))).toBe(true);
    });

    it("keeps returning records when the native lock adapter cannot load", () => {
      const gone = path.join(tmpDir, "gone-adapter");
      fs.mkdirSync(gone, { recursive: true });
      writeAgentRecord(lead("ab12cd34", gone, 100));
      const alive = lead("ef56gh78", dirA, 200);
      writeAgentRecord(alive);
      // Make the stale socket exist so its removal is observable.
      fs.mkdirSync(path.dirname(agentSocketPath("ab12cd34")), { recursive: true, mode: 0o700 });
      fs.writeFileSync(agentSocketPath("ab12cd34"), "", { mode: 0o600 });
      fs.rmSync(gone, { recursive: true });

      const writes: string[] = [];
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(((chunk: Uint8Array | string) => {
          writes.push(String(chunk));
          return true;
        }) as typeof process.stderr.write);
      __setNativeLockLoaderForTests(() => {
        throw new Error("no prebuilt binary for this platform");
      });
      try {
        // A missing adapter degrades to history-skip, never to a rejected
        // load: authorizeSender reads records on every inbound message.
        expect(() => readAgentRecords()).not.toThrow();
        expect(readAgentRecords()).toEqual([alive]);
        // Locking can never succeed this session, so the stale record and
        // socket are removed now instead of leaking; the skipped history
        // entries self-heal on the next successful syncAgentHistory pass.
        expect(fs.existsSync(agentRecordPath("ab12cd34"))).toBe(false);
        expect(fs.existsSync(agentSocketPath("ab12cd34"))).toBe(false);
        // One warning per process across both calls.
        expect(writes.filter((w) => w.includes("fs-native-extensions"))).toHaveLength(1);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("degrades to history-skip when the filesystem rejects advisory locking", () => {
      // One test covers both consensus items for the filesystem reason: the
      // tryLock errno is classified as skippable LockUnavailableError, and
      // the trim removes the stale records because the history batch can
      // never succeed on this mount.
      const gone = path.join(tmpDir, "gone-enotsup");
      fs.mkdirSync(gone, { recursive: true });
      writeAgentRecord(lead("ab12cd34", gone, 100));
      const alive = lead("ef56gh78", dirA, 200);
      writeAgentRecord(alive);
      // Make the stale socket exist so its removal is observable.
      fs.mkdirSync(path.dirname(agentSocketPath("ab12cd34")), { recursive: true, mode: 0o700 });
      fs.writeFileSync(agentSocketPath("ab12cd34"), "", { mode: 0o600 });
      fs.rmSync(gone, { recursive: true });

      const writes: string[] = [];
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(((chunk: Uint8Array | string) => {
          writes.push(String(chunk));
          return true;
        }) as typeof process.stderr.write);
      const errnoCode = util.getSystemErrorName(-os.constants.errno.ENOTSUP);
      const errnos: string[] = [];
      __setNativeLockLoaderForTests(() => ({
        tryLock: () => {
          const error = new Error("Operation not supported") as NodeJS.ErrnoException;
          error.code = errnoCode;
          errnos.push(error.code);
          throw error;
        },
        unlock: () => undefined,
      }));

      try {
        // Registration and reading survive an NFS/SMB/FUSE mount that cannot
        // lock; the history stamp is skipped, not fatal.
        expect(() => writeAgentRecord(alive)).not.toThrow();
        expect(() => readAgentRecords()).not.toThrow();
        expect(readAgentRecords()).toEqual([alive]);
        // Stale record and socket removed now: deletion eligibility comes from
        // the missing cwd, never from lock state.
        expect(fs.existsSync(agentRecordPath("ab12cd34"))).toBe(false);
        expect(fs.existsSync(agentSocketPath("ab12cd34"))).toBe(false);
        // tryLock errored once per history-touching operation, none cached.
        expect(errnos.length).toBeGreaterThanOrEqual(2);
        // One warning per process for the FilesystemUnsupported reason.
        expect(writes.filter((w) => w.includes("ENOTSUP"))).toHaveLength(1);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("degrades every entry point when the adapter throws the libuv shape for ENOLCK", async () => {
      // The adapter maps errno through libuv's uv_err_name: ENOLCK surfaces
      // as "Unknown system error -N", never as "ENOLCK". This test injects
      // the exact string the real adapter emits and asserts that every
      // history-touching entry point degrades instead of throwing.
      const writes: string[] = [];
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(((chunk: Uint8Array | string) => {
          writes.push(String(chunk));
          return true;
        }) as typeof process.stderr.write);
      const errnoCode = util.getSystemErrorName(-os.constants.errno.ENOLCK);
      __setNativeLockLoaderForTests(() => ({
        tryLock: () => {
          const error = new Error("lockd not running") as NodeJS.ErrnoException;
          error.code = errnoCode;
          throw error;
        },
        unlock: () => undefined,
      }));

      try {
        const gone = path.join(tmpDir, "gone-enolck");
        fs.mkdirSync(gone, { recursive: true });
        writeAgentRecord(lead("ab12cd34", gone, 100));
        const alive = lead("ef56gh78", dirA, 200);
        // Make the stale socket exist so its removal is observable.
        fs.mkdirSync(path.dirname(agentSocketPath("ab12cd34")), { recursive: true, mode: 0o700 });
        fs.writeFileSync(agentSocketPath("ab12cd34"), "", { mode: 0o600 });
        fs.rmSync(gone, { recursive: true });

        // Registration, the read-path trim, the list pass, and teardown all
        // skip history work instead of rejecting.
        expect(() => writeAgentRecord(alive)).not.toThrow();
        expect(() => readAgentRecords()).not.toThrow();
        expect(readAgentRecords()).toEqual([alive]);
        await expect(pruneAndList(async () => AgentStatus.Idling)).resolves.toHaveLength(1);
        expect(() => removeAgentRecord("ef56gh78")).not.toThrow();
        // The stale record and its socket were removed by the trim even
        // though the history batch was skipped.
        expect(fs.existsSync(agentRecordPath("ab12cd34"))).toBe(false);
        expect(fs.existsSync(agentSocketPath("ab12cd34"))).toBe(false);
        // One warning per process for the FilesystemUnsupported reason,
        // naming the canonical errno.
        expect(writes.filter((w) => w.includes("ENOLCK"))).toHaveLength(1);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("returns the first load unchanged when every working directory exists", () => {
      const rec: AgentRecord = lead("ab12cd34", dirA, 100);
      writeAgentRecord(rec);
      expect(readAgentRecords()).toEqual([rec]);
      expect(fs.existsSync(agentRecordPath("ab12cd34"))).toBe(true);
    });
  });

  describe("readAgentRecord", () => {
    it("returns a specific record", () => {
      const rec: AgentRecord = {
        id: "ab12cd34",
        kind: AgentKind.Lead,
        cwd: "/tmp",
        pid: 1234,
        startedAt: 1000,
      };
      writeAgentRecord(rec);
      expect(readAgentRecord("ab12cd34")).toEqual(rec);
    });

    it("returns undefined for a missing record", () => {
      expect(readAgentRecord("ab12cd34")).toBeUndefined();
    });

    it("returns undefined for an invalid record file", () => {
      ensureRegistryDir();
      const dir = path.join(registryDir(), "agents");
      fs.writeFileSync(path.join(dir, "ab12cd34.json"), "not json");
      expect(readAgentRecord("ab12cd34")).toBeUndefined();
    });
  });

  describe("removeAgentRecord", () => {
    it("removes a record", () => {
      const rec: AgentRecord = {
        id: "ab12cd34",
        kind: AgentKind.Lead,
        cwd: "/tmp",
        pid: 1234,
        startedAt: 1000,
      };
      writeAgentRecord(rec);
      removeAgentRecord("ab12cd34");
      expect(fs.existsSync(agentRecordPath("ab12cd34"))).toBe(false);
    });

    it("ignores ENOENT", () => {
      expect(() => removeAgentRecord("ab12cd34")).not.toThrow();
    });
  });

  describe("updateAgentRecord", () => {
    it("patches an existing record and persists it", () => {
      const rec: AgentRecord = {
        id: "ab12cd34",
        kind: AgentKind.Lead,
        cwd: "/tmp",
        pid: 1234,
        startedAt: 1000,
      };
      writeAgentRecord(rec);
      updateAgentRecord("ab12cd34", { paneId: "pane-1", windowId: "win-1" });
      const updated = readAgentRecord("ab12cd34");
      expect(updated).toEqual({
        id: "ab12cd34",
        kind: AgentKind.Lead,
        cwd: "/tmp",
        pid: 1234,
        paneId: "pane-1",
        windowId: "win-1",
        startedAt: 1000,
      });
    });

    it("throws when the record does not exist", () => {
      expect(() => updateAgentRecord("zz99zz99", { paneId: "pane-1" })).toThrow("zz99zz99 not found");
    });

    it("cannot overwrite the id", () => {
      const rec: AgentRecord = {
        id: "ab12cd34",
        kind: AgentKind.Lead,
        cwd: "/tmp",
        pid: 1234,
        startedAt: 1000,
      };
      writeAgentRecord(rec);
      updateAgentRecord("ab12cd34", { id: "zz99zz99", paneId: "pane-1" } as any);
      expect(readAgentRecord("ab12cd34")?.id).toBe("ab12cd34");
    });

    it("does not refresh lastSeenAt in the history when patching metadata", () => {
      writeAgentRecord(lead("ab12cd34", dirA, 1000));
      const stamped = readAgentHistory().find(
        (e) => historyKey(e.cwd, e.startedAt) === historyKey(dirA, 1000),
      );
      expect(stamped).toBeDefined();

      // If the patch stamped the record, the mocked clock would show it.
      const clock = vi.spyOn(Date, "now").mockReturnValue(9_999_999);
      try {
        updateAgentRecord("ab12cd34", { paneId: "pane-1", windowId: "win-1" });
      } finally {
        clock.mockRestore();
      }

      expect(readAgentRecord("ab12cd34")?.paneId).toBe("pane-1");
      const after = readAgentHistory().find(
        (e) => historyKey(e.cwd, e.startedAt) === historyKey(dirA, 1000),
      );
      expect(after?.lastSeenAt).toBe(stamped?.lastSeenAt);
    });
  });

  describe("isPidAlive", () => {
    it("returns true for the current process", () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it("counts a pid owned by another user as alive (EPERM)", () => {
      // pid 1 belongs to root; a non-root caller gets EPERM, which is alive.
      expect(isPidAlive(1)).toBe(true);
    });

    it("returns false for a dead pid", async () => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
      const pid = child.pid as number;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      expect(isPidAlive(pid)).toBe(false);
    });
  });

  describe("agentStatus", () => {
    function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
      return {
        id: "ab12cd34",
        kind: AgentKind.Teammate,
        cwd: "/tmp",
        pid: process.pid,
        startedAt: 1000,
        leadId: "ef56gh78",
        name: "worker",
        ...overrides,
      };
    }

    it("is Idling when the pid is alive and the socket accepts connections", async () => {
      const calls: string[] = [];
      const status = await agentStatus(
        makeRecord(),
        async (address) => {
          calls.push(address);
          return address === agentSocketPath("ab12cd34");
        },
        (pid) => {
          calls.push(String(pid));
          return pid === process.pid;
        },
      );
      expect(status).toBe(AgentStatus.Idling);
      expect(calls).toEqual([String(process.pid), agentSocketPath("ab12cd34")]);
    });

    it("is Offline when the pid is alive but nothing listens on the socket", async () => {
      const status = await agentStatus(makeRecord(), async () => false, () => true);
      expect(status).toBe(AgentStatus.Offline);
    });

    it("is Offline for a dead pid even when the probe says the socket accepts connections", async () => {
      let probes = 0;
      const status = await agentStatus(
        makeRecord({ pid: 999999 }),
        async () => {
          probes++;
          return true;
        },
        () => false,
      );
      expect(status).toBe(AgentStatus.Offline);
      expect(probes).toBe(0);
    });

    it("probes the agent's real socket with the default probe", async () => {
      ensureRegistryDir();
      const id = "ab12cd35";
      const address = agentSocketPath(id);
      const server = net.createServer(() => {});
      await new Promise<void>((resolve) => server.listen(address, () => resolve()));
      try {
        await expect(agentStatus(makeRecord({ id }))).resolves.toBe(AgentStatus.Idling);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await expect(agentStatus(makeRecord({ id }))).resolves.toBe(AgentStatus.Offline);
    });
  });

  describe("adoptOrphanedWorkers", () => {
    it("adopts workers whose owner lead has no record, in the lead's cwd", () => {
      writeAgentRecord(lead("ad000001", dirA, 100));
      writeAgentRecord({ ...worker("bb000002", 1), cwd: dirA });
      writeAgentRecord({ ...worker("cc000003", 2), cwd: dirA });
      writeAgentRecord({ ...worker("dd000004", 3), cwd: dirB });
      writeAgentRecord(lead("ee000005", dirA, 50));
      writeAgentRecord(lead("ff000006", dirC, 10));

      const adopted = adoptOrphanedWorkers(lead("ad000001", dirA, 100));

      expect(adopted).toEqual(["bb000002", "cc000003"]);
      expect(readAgentRecord("bb000002")?.leadId).toBe("ad000001");
      expect(readAgentRecord("cc000003")?.leadId).toBe("ad000001");
      // Worker with a live owner in another cwd stays untouched.
      expect(readAgentRecord("dd000004")?.leadId).toBe("aa000001");
    });

    it("leaves workers with no leadId alone", () => {
      writeAgentRecord(lead("ad000001", dirA, 1));
      const orphan: AgentRecord = { id: "bb000002", kind: AgentKind.Teammate, cwd: dirA, pid: 1, startedAt: 1 };
      writeAgentRecord(orphan);
      expect(adoptOrphanedWorkers(lead("ad000001", dirA, 1))).toEqual([]);
    });

    it("keeps the adopted worker's registration stamp instead of refreshing lastSeenAt", () => {
      writeAgentRecord(lead("ad000001", dirA, 100));
      writeAgentRecord({ ...worker("bb000002", 1), cwd: dirA });
      const before = readAgentHistory().find(
        (e) => historyKey(e.cwd, e.startedAt) === historyKey(dirA, 1),
      );
      expect(before).toBeDefined();

      // Adopting an offline worker must not mark it as recently seen.
      const clock = vi.spyOn(Date, "now").mockReturnValue(9_999_999);
      try {
        expect(adoptOrphanedWorkers(lead("ad000001", dirA, 100))).toEqual(["bb000002"]);
      } finally {
        clock.mockRestore();
      }

      const after = readAgentHistory().find(
        (e) => historyKey(e.cwd, e.startedAt) === historyKey(dirA, 1),
      );
      expect(after?.lastSeenAt).toBe(before?.lastSeenAt);
    });
  });

  describe("pruneRegistry", () => {
    interface Case {
      name: string;
      records: AgentRecord[];
      statuses: Array<[string, AgentStatus]>;
      expectKeep: string[];
      expectRemove: string[];
    }

    const cases: Case[] = [
      {
        name: "keeps a busy worker: mid-run agents must not be pruned",
        records: [worker("bb000002", 2)],
        statuses: [["bb000002", AgentStatus.Busy]],
        expectKeep: ["bb000002"],
        expectRemove: [],
      },
      {
        name: "keeps a busy lead and removes offline leads in the same directory",
        records: [lead("aa000001", "/a", 10), lead("bb000002", "/a", 50)],
        statuses: [
          ["aa000001", AgentStatus.Busy],
          ["bb000002", AgentStatus.Offline],
        ],
        expectKeep: ["aa000001"],
        expectRemove: ["bb000002"],
      },
      {
        name: "returns empty results for an empty registry",
        records: [],
        statuses: [],
        expectKeep: [],
        expectRemove: [],
      },
      {
        name: "keeps an online worker and removes an offline worker",
        records: [worker("bb000002", 2), worker("cc000003", 3, AgentKind.ReadonlyWorker)],
        statuses: [
          ["bb000002", AgentStatus.Idling],
          ["cc000003", AgentStatus.Offline],
        ],
        expectKeep: ["bb000002"],
        expectRemove: ["cc000003"],
      },
      {
        name: "removes every offline lead in a directory that has an available lead",
        records: [lead("aa000001", "/a", 10), lead("bb000002", "/a", 50), lead("cc000003", "/a", 20)],
        statuses: [
          ["aa000001", AgentStatus.Idling],
          ["bb000002", AgentStatus.Offline],
          ["cc000003", AgentStatus.Offline],
        ],
        expectKeep: ["aa000001"],
        expectRemove: ["bb000002", "cc000003"],
      },
      {
        name: "keeps only the newest offline lead in a directory with no online lead",
        records: [lead("aa000001", "/a", 100), lead("bb000002", "/a", 300), lead("cc000003", "/a", 200)],
        statuses: [
          ["aa000001", AgentStatus.Offline],
          ["bb000002", AgentStatus.Offline],
          ["cc000003", AgentStatus.Offline],
        ],
        expectKeep: ["bb000002"],
        expectRemove: ["aa000001", "cc000003"],
      },
      {
        name: "breaks a startedAt tie by the lexicographically greatest id",
        records: [lead("aaa00000", "/a", 500), lead("zzz99999", "/a", 500)],
        statuses: [
          ["aaa00000", AgentStatus.Offline],
          ["zzz99999", AgentStatus.Offline],
        ],
        expectKeep: ["zzz99999"],
        expectRemove: ["aaa00000"],
      },
      {
        name: "keeps a lone offline lead in a directory with no online lead",
        records: [lead("aa000001", "/c", 5)],
        statuses: [["aa000001", AgentStatus.Offline]],
        expectKeep: ["aa000001"],
        expectRemove: [],
      },
      {
        name: "applies the rules independently to two directories",
        records: [
          lead("aa000001", "/a", 10),
          worker("bb000002", 60),
          lead("cc000003", "/a", 50),
          lead("dd000004", "/b", 100),
          lead("ee000005", "/b", 200),
          lead("ff000006", "/c", 5),
        ],
        statuses: [
          ["aa000001", AgentStatus.Idling],
          ["bb000002", AgentStatus.Offline],
          ["cc000003", AgentStatus.Offline],
          ["dd000004", AgentStatus.Offline],
          ["ee000005", AgentStatus.Offline],
          ["ff000006", AgentStatus.Offline],
        ],
        expectKeep: ["aa000001", "ee000005", "ff000006"],
        expectRemove: ["bb000002", "cc000003", "dd000004"],
      },
      {
        name: "treats a record with no status as offline",
        records: [lead("aa000001", "/a", 10), lead("bb000002", "/a", 50), worker("cc000003", 1)],
        statuses: [["aa000001", AgentStatus.Idling]],
        expectKeep: ["aa000001"],
        expectRemove: ["bb000002", "cc000003"],
      },
      {
        name: "returns keep and remove in input order",
        records: [
          lead("aa000001", "/a", 300),
          worker("bb000002", 1),
          lead("cc000003", "/a", 100),
          worker("dd000004", 2),
        ],
        statuses: [
          ["aa000001", AgentStatus.Offline],
          ["bb000002", AgentStatus.Offline],
          ["cc000003", AgentStatus.Offline],
          ["dd000004", AgentStatus.Idling],
        ],
        expectKeep: ["aa000001", "dd000004"],
        expectRemove: ["bb000002", "cc000003"],
      },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const { keep, remove } = pruneRegistry(c.records, new Map(c.statuses));
        expect(keep.map((r) => r.id)).toEqual(c.expectKeep);
        expect(remove).toEqual(c.expectRemove);
      });
    }

    it("does not mutate its inputs", () => {
      const records = [worker("bb000002", 2), lead("cc000003", "/a", 1)];
      const statuses = new Map<string, AgentStatus>([["bb000002", AgentStatus.Idling]]);
      const snapshot = records.map((r) => ({ ...r }));
      pruneRegistry(records, statuses);
      expect(records).toEqual(snapshot);
      expect(statuses.get("bb000002")).toBe(AgentStatus.Idling);
    });
  });

  describe("pruneAndList", () => {
    function makeSocketFile(id: string): void {
      ensureRegistryDir();
      fs.writeFileSync(agentSocketPath(id), "");
    }

    it("returns survivors without throwing when the history lock is held", async () => {
      ensureRegistryDir();
      const rec = lead("aa000001", dirA, 300);
      writeAgentRecord(rec);
      holdHistoryLock();
      vi.stubEnv("PI_TEAMS_LOCK_WAIT_TIMEOUT_MS", "40");

      const entries = await pruneAndList(async () => Promise.resolve(AgentStatus.Idling));
      expect(entries).toEqual([{ record: rec, status: AgentStatus.Idling }]);
    });

    it("removes offline records and their stale socket files, returns survivors with statuses", async () => {
      const onlineLead: AgentRecord = lead("aa000001", dirA, 300);
      const offlineWorker: AgentRecord = worker("bb000002", 400);
      const onlineWorker: AgentRecord = worker("cc000003", 500);
      const offlineLead: AgentRecord = lead("dd000004", dirA, 10);
      for (const rec of [onlineLead, offlineWorker, onlineWorker, offlineLead]) {
        writeAgentRecord(rec);
        makeSocketFile(rec.id);
      }

      const entries: AgentEntry[] = await pruneAndList(async (rec) =>
        Promise.resolve(
          rec.id === "bb000002" || rec.id === "dd000004"
            ? AgentStatus.Offline
            : AgentStatus.Idling,
        ),
      );

      expect(entries).toEqual([
        { record: onlineLead, status: AgentStatus.Idling },
        { record: onlineWorker, status: AgentStatus.Idling },
      ]);
      for (const id of ["bb000002", "dd000004"]) {
        expect(fs.existsSync(agentRecordPath(id))).toBe(false);
        expect(fs.existsSync(agentSocketPath(id))).toBe(false);
      }
      for (const id of ["aa000001", "cc000003"]) {
        expect(fs.existsSync(agentRecordPath(id))).toBe(true);
        expect(fs.existsSync(agentSocketPath(id))).toBe(true);
      }
    });

    it("ignores a missing socket file when pruning an offline record", async () => {
      const offlineWorker: AgentRecord = worker("dd000004", 1);
      writeAgentRecord(offlineWorker);
      // No socket file exists for dd000004.
      const entries = await pruneAndList(async () => Promise.resolve(AgentStatus.Offline));
      expect(entries).toEqual([]);
      expect(fs.existsSync(agentRecordPath("dd000004"))).toBe(false);
    });

    it("stamps lastSeenAt in the history for agents found online", async () => {
      const onlineLead: AgentRecord = lead("aa000001", dirA, 300);
      const offlineLead: AgentRecord = lead("bb000002", dirB, 400);
      writeAgentRecord(onlineLead);
      writeAgentRecord(offlineLead);
      const lastSeenBefore = new Map(
        readAgentHistory().map((e) => [historyKey(e.cwd, e.startedAt), e.lastSeenAt]),
      );

      const clock = vi.spyOn(Date, "now").mockReturnValue(999_999);
      try {
        await pruneAndList(async (rec) =>
          Promise.resolve(
            rec.id === "bb000002" ? AgentStatus.Offline : AgentStatus.Idling,
          ),
        );
      } finally {
        clock.mockRestore();
      }

      // The online lead is stamped with the prune-time clock; the offline
      // lead keeps its registration-time stamp.
      const lastSeenByCwd = new Map(
        readAgentHistory().map((e) => [historyKey(e.cwd, e.startedAt), e.lastSeenAt]),
      );
      expect(lastSeenByCwd.get(historyKey(dirA, 300))).toBe(999_999);
      expect(lastSeenByCwd.get(historyKey(dirB, 400))).toBe(
        lastSeenBefore.get(historyKey(dirB, 400)),
      );
    });

    it("collapses duplicate history entries for a cwd whose records are all offline", async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(999_999);
      let offlineLead: AgentRecord;
      try {
        offlineLead = lead("bb000002", dirB, 50);
        writeAgentRecord(offlineLead);
        // Simulate a leftover older entry for the same cwd.
        const entries = [
          ...readAgentHistory(),
          { cwd: dirB, startedAt: 10, lastSeenAt: 5 },
        ];
        fs.writeFileSync(
          agentHistoryPath(),
          entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
          { mode: 0o600 },
        );

        await pruneAndList(async () => Promise.resolve(AgentStatus.Offline));
      } finally {
        clock.mockRestore();
      }

      const after = readAgentHistory().filter((e) => e.cwd === dirB);
      expect(after).toEqual([{ cwd: dirB, startedAt: 50, lastSeenAt: 999_999 }]);
    });

    it("keeps the pruned lead's newer lastSeenAt on the surviving lead's entry", async () => {
      const older: AgentRecord = lead("bb000002", dirB, 100);
      const newer: AgentRecord = lead("cc000003", dirB, 200);
      writeAgentRecord(older);
      writeAgentRecord(newer);
      // The older lead was online until recently (5000); the survivor has
      // not been online since it registered (200).
      const patched = readAgentHistory().map((e) => {
        if (e.cwd !== dirB) return e;
        if (e.startedAt === 100) return { ...e, lastSeenAt: 5000 };
        if (e.startedAt === 200) return { ...e, lastSeenAt: 200 };
        return e;
      });
      fs.writeFileSync(
        agentHistoryPath(),
        patched.map((e) => JSON.stringify(e)).join("\n") + "\n",
        { mode: 0o600 },
      );

      const entries = await pruneAndList(async () => Promise.resolve(AgentStatus.Offline));

      // pruneRegistry keeps only the newer lead; the survivor's entry must
      // carry the directory's real recency (5000), not the newer record's
      // stale stamp.
      expect(entries).toEqual([{ record: newer, status: AgentStatus.Offline }]);
      expect(readAgentHistory().filter((e) => e.cwd === dirB)).toEqual([
        { cwd: dirB, startedAt: 200, lastSeenAt: 5000 },
      ]);
    });

    it("does not drop the entry of a record registered while the probes run", async () => {
      const offlineLead: AgentRecord = lead("bb000002", dirB, 200);
      writeAgentRecord(offlineLead);

      let lateStartedAt = 0;
      const entries = await pruneAndList(async (rec) => {
        // Register mid-probe like a session that starts between the snapshot
        // read and the socket probes. Its startedAt is past snapshotTime.
        lateStartedAt = Date.now() + 1;
        writeAgentRecord(lead("ee000008", dirB, lateStartedAt));
        return Promise.resolve(rec.id === "bb000002" ? AgentStatus.Offline : AgentStatus.Idling);
      });

      expect(entries).toEqual([{ record: offlineLead, status: AgentStatus.Offline }]);
      const dirBEntries = readAgentHistory().filter((e) => e.cwd === dirB);
      expect(dirBEntries).toHaveLength(2);
      expect(dirBEntries.map((e) => e.startedAt)).toContain(lateStartedAt);
    });

    it("keeps a same-millisecond registration entry through a prune", async () => {
      // A stale record forces readAgentRecords to run its trim.
      const dirStale = path.join(tmpDir, "stale-ms");
      fs.mkdirSync(dirStale);
      writeAgentRecord(lead("aa000001", dirStale, 100));
      fs.rmSync(dirStale, { recursive: true });
      // A live record keeps the probe loop running so a session can register
      // in the snapshot's millisecond.
      writeAgentRecord(lead("bb000002", dirA, 50));

      const clock = vi.spyOn(Date, "now").mockReturnValue(500);
      try {
        await pruneAndList(async () => {
          // Registered between the snapshot read and the probe: startedAt
          // and lastSeenAt both equal snapshotTime, and the key is absent
          // from the snapshot.
          writeAgentRecord(lead("ee000008", dirA, 500));
          return Promise.resolve(AgentStatus.Idling);
        });
      } finally {
        clock.mockRestore();
      }

      const entries = readAgentHistory();
      expect(entries.filter((e) => e.cwd === dirA && e.startedAt === 500)).toHaveLength(1);
      expect(entries.some((e) => e.cwd === dirStale)).toBe(false);
    });

    it("keeps the shared history entry when one same-key sibling is removed", () => {
      const first: AgentRecord = { ...lead("bb000002", dirB, 77), kind: AgentKind.Teammate };
      const second: AgentRecord = { ...lead("cc000003", dirB, 77), kind: AgentKind.Teammate };
      writeAgentRecord(first);
      writeAgentRecord(second);
      expect(readAgentHistory().filter((e) => e.cwd === dirB)).toHaveLength(1);

      // Closing one sibling must not strip the survivor's recency.
      removeAgentRecord("bb000002");
      const afterFirst = readAgentHistory().filter((e) => e.cwd === dirB);
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0].startedAt).toBe(77);

      // Closing the last sibling removes the entry for good.
      removeAgentRecord("cc000003");
      expect(readAgentHistory().filter((e) => e.cwd === dirB)).toHaveLength(0);
    });

    it("keeps the newest offline lead per directory using the default status check", async () => {
      // Dead pid and no socket make agentStatus deterministically Offline.
      const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
      const pid = child.pid as number;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });

      const older: AgentRecord = { id: "ee000005", kind: AgentKind.Lead, cwd: dirB, pid, startedAt: 1 };
      const newer: AgentRecord = { id: "ff000006", kind: AgentKind.Lead, cwd: dirB, pid, startedAt: 2 };
      writeAgentRecord(older);
      writeAgentRecord(newer);

      const entries = await pruneAndList();
      expect(entries).toEqual([{ record: newer, status: AgentStatus.Offline }]);
      expect(fs.existsSync(agentRecordPath("ee000005"))).toBe(false);
      expect(fs.existsSync(agentRecordPath("ff000006"))).toBe(true);
    });
  });
});
