import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  AGENT_ID_PATTERN,
  agentRecordPath,
  agentRecordsDir,
  agentSocketPath,
  assertAgentId,
  registryDir,
} from "./paths.js";

const VALID_ID = "ab12cd34";

describe("AGENT_ID_PATTERN", () => {
  it("accepts 8 lowercase alphanumeric characters", () => {
    expect(AGENT_ID_PATTERN.test("ab12cd34")).toBe(true);
    expect(AGENT_ID_PATTERN.test("00000000")).toBe(true);
  });

  it("rejects other shapes", () => {
    expect(AGENT_ID_PATTERN.test("../x")).toBe(false);
    expect(AGENT_ID_PATTERN.test("AB12CD34")).toBe(false);
    expect(AGENT_ID_PATTERN.test("ab12cd3")).toBe(false);
    expect(AGENT_ID_PATTERN.test("ab12cd345")).toBe(false);
    expect(AGENT_ID_PATTERN.test("")).toBe(false);
  });
});

describe("assertAgentId", () => {
  it("accepts a valid id", () => {
    expect(() => assertAgentId(VALID_ID)).not.toThrow();
  });

  it("throws on path traversal input", () => {
    expect(() => assertAgentId("../x")).toThrow(/Invalid agent ID/);
  });

  it("throws on uppercase ids", () => {
    expect(() => assertAgentId("AB12CD34")).toThrow(/Invalid agent ID/);
  });

  it("throws on wrong length", () => {
    expect(() => assertAgentId("ab12cd3")).toThrow(/Invalid agent ID/);
    expect(() => assertAgentId("ab12cd345")).toThrow(/Invalid agent ID/);
  });
});

describe("registryDir", () => {
  it("lives under ~/.pi/agent/pi-teams by default", () => {
    const saved = process.env.PI_TEAMS_REGISTRY_DIR;
    delete process.env.PI_TEAMS_REGISTRY_DIR;
    try {
      expect(registryDir()).toBe(path.join(os.homedir(), ".pi", "agent", "pi-teams"));
    } finally {
      if (saved !== undefined) process.env.PI_TEAMS_REGISTRY_DIR = saved;
    }
  });

  it("honors the PI_TEAMS_REGISTRY_DIR override", () => {
    const saved = process.env.PI_TEAMS_REGISTRY_DIR;
    process.env.PI_TEAMS_REGISTRY_DIR = "/elsewhere";
    try {
      expect(registryDir()).toBe("/elsewhere");
    } finally {
      if (saved !== undefined) process.env.PI_TEAMS_REGISTRY_DIR = saved;
      else delete process.env.PI_TEAMS_REGISTRY_DIR;
    }
  });
});

describe("agentRecordsDir", () => {
  it("sits under the registry dir", () => {
    expect(agentRecordsDir()).toBe(path.join(registryDir(), "agents"));
  });
});

describe("agentRecordPath", () => {
  it("returns the record file for a valid id", () => {
    expect(agentRecordPath(VALID_ID)).toBe(path.join(registryDir(), "agents", `${VALID_ID}.json`));
  });

  it("rejects an invalid id", () => {
    expect(() => agentRecordPath("../x")).toThrow(/Invalid agent ID/);
  });
});

describe("agentSocketPath", () => {
  it("returns the socket path for a valid id", () => {
    const socket = agentSocketPath(VALID_ID);
    if (process.platform === "win32") {
      expect(socket).toMatch(/^\\\\\.\\pipe\\pi-.+-.+$/);
    } else {
      expect(socket).toBe(path.join(registryDir(), "s", `${VALID_ID}.sock`));
    }
    expect(socket.length).toBeLessThanOrEqual(90);
  });

  it("rejects an invalid id", () => {
    expect(() => agentSocketPath("../x")).toThrow(/Invalid agent ID/);
  });
});
