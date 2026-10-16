import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentKind, AgentRecord } from "./models";
import {
  ensureRegistryDir,
  generateAgentId,
  readAgentRecord,
  readAgentRecords,
  removeAgentRecord,
  writeAgentRecord,
} from "./registry";
import { agentRecordPath, registryDir } from "./paths";

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("registry", () => {
  let tmpDir: string;
  let originalTmpdir: string | undefined;

  beforeEach(() => {
    originalTmpdir = process.env.TMPDIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-"));
    process.env.TMPDIR = tmpDir;
  });

  afterEach(() => {
    if (originalTmpdir !== undefined) {
      process.env.TMPDIR = originalTmpdir;
    } else {
      delete process.env.TMPDIR;
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
        cwd: "/home",
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
});
