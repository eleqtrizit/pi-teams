import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import presenceExtension from "./index";

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
  supportsWindows: () => false,
}));

/** Load the extension and keep its event handlers. */
function loadExtension(): {
  handlers: { get(name: string): (...args: any[]) => Promise<void> };
} {
  const registered = new Map<string, any[]>();
  const handlers = {
    get: (name: string) => async (...args: any[]) => {
      for (const handler of registered.get(name) ?? []) await handler(...args);
    },
  };
  presenceExtension({
    on: (name: string, handler: any) =>
      registered.set(name, [...(registered.get(name) ?? []), handler]),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any);
  return { handlers };
}

function socketUserId(): string {
  if (typeof process.getuid === "function") return String(process.getuid());
  return os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "_");
}

describe("agent presence registration", () => {
  let tmpDir: string;
  let originalTmpDir: string | undefined;
  const ui = { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r"));
    originalTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = tmpDir;
    vi.stubEnv("PI_AGENT_ID", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.stubEnv("PI_LEAD_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalTmpDir !== undefined) {
      process.env.TMPDIR = originalTmpDir;
    } else {
      delete process.env.TMPDIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a record file with correct fields after session_start for a lead with UI", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "lead");

    const { handlers } = loadExtension();
    const ctx = {
      ui,
      hasUI: true,
      model: { provider: "openai", id: "gpt-4" },
    };
    await handlers.get("session_start")({}, ctx);

    const recordDir = path.join(
      tmpDir,
      `pi-${socketUserId()}`,
      "agents",
    );
    const files = fs.readdirSync(recordDir);
    expect(files.length).toBe(1);

    const record = JSON.parse(
      fs.readFileSync(path.join(recordDir, files[0]), "utf8"),
    );
    expect(record.kind).toBe("lead");
    expect(record.cwd).toBe(process.cwd());
    expect(record.pid).toBe(process.pid);
    expect(record.leadId).toBeUndefined();
    expect(record.name).toBeUndefined();
    expect(record.model).toBe("openai/gpt-4");
    expect(record.startedAt).toBeGreaterThan(0);
    expect(record.id).toMatch(/^[a-z0-9]{8}$/);
    expect(record.id).toBe(process.env.PI_AGENT_ID);
  });

  it("does not write a record for an unspawned no-UI lead", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "lead");

    const { handlers } = loadExtension();
    const ctx = { ui, hasUI: false };
    await handlers.get("session_start")({}, ctx);

    const recordDir = path.join(
      tmpDir,
      `pi-${socketUserId()}`,
      "agents",
    );
    expect(fs.existsSync(recordDir)).toBe(false);
  });

  it("writes a worker record with leadId and name", async () => {
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_LEAD_ID", "lead99ab");

    const { handlers } = loadExtension();
    const ctx = {
      ui,
      hasUI: false,
      model: { provider: "anthropic", id: "claude-3" },
    };
    await handlers.get("session_start")({}, ctx);

    const recordDir = path.join(tmpDir, `pi-${socketUserId()}`, "agents");
    const files = fs.readdirSync(recordDir);
    expect(files.length).toBe(1);

    const record = JSON.parse(
      fs.readFileSync(path.join(recordDir, files[0]), "utf8"),
    );
    expect(record.kind).toBe("teammate");
    expect(record.leadId).toBe("lead99ab");
    expect(record.name).toBe("worker-1");
    expect(record.model).toBe("anthropic/claude-3");
    expect(record.id).toMatch(/^[a-z0-9]{8}$/);
  });

  it("sets the title and status for a lead without a team", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "lead");

    const { handlers } = loadExtension();
    const ctx = { ui, hasUI: true };
    await handlers.get("session_start")({}, ctx);

    expect(ui.setTitle).toHaveBeenCalledWith(
      expect.stringContaining("Agent: "),
    );
    expect(ui.setStatus).toHaveBeenCalledWith(
      "pi-teams",
      expect.stringContaining("Agent: "),
    );
  });

  it("uses the pre-assigned PI_AGENT_ID when available", async () => {
    vi.stubEnv("PI_AGENT_ID", "abc12345");
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "lead");

    const { handlers } = loadExtension();
    const ctx = { ui, hasUI: true };
    await handlers.get("session_start")({}, ctx);

    expect(process.env.PI_AGENT_ID).toBe("abc12345");

    const recordDir = path.join(
      tmpDir,
      `pi-${socketUserId()}`,
      "agents",
    );
    const files = fs.readdirSync(recordDir);
    expect(files.length).toBe(1);

    const record = JSON.parse(
      fs.readFileSync(path.join(recordDir, files[0]), "utf8"),
    );
    expect(record.id).toBe("abc12345");
  });
});
