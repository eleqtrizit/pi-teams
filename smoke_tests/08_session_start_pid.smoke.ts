// CLAIM S8: a worker's own pid file is deleted by its first-activation cleanup.
// session_start writes <agent>.pid, then resetAgentState (which now includes pid and active files) removes it.
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../src/utils/paths";
import theExtension from "../extensions/index";

describe("S8 session_start pid survives cleanup", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it("leaves the worker pid file in place when no firstActivation stamp exists", async () => {
    vi.stubEnv("PI_AGENT_NAME", "w1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_TEAM_NAME", "t");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ss-"));
    const f = (n: string) => (_t: string, a: string) => path.join(dir, `${a}.${n}`);
    vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
    vi.spyOn(paths, "teamDir").mockReturnValue(dir);
    vi.spyOn(paths, "pidPath").mockImplementation(f("pid"));
    vi.spyOn(paths, "activePath").mockImplementation(f("active"));
    vi.spyOn(paths, "firstActivationPath").mockImplementation(f("firstActivation"));

    const handlers: Record<string, any> = {};
    theExtension({
      on: (n: string, h: any) => { handlers[n] = h; },
      registerTool: vi.fn(), registerCommand: vi.fn(), registerEntryRenderer: vi.fn(), sendUserMessage: vi.fn(),
    } as any);
    const ui = { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() };
    await handlers["session_start"]({}, { ui, hasUI: false });
    await handlers["session_shutdown"]({}, {});
    const pidExistedAtStart = fs.existsSync(path.join(dir, "w1.firstActivation"));
    console.log("firstActivation stamped:", pidExistedAtStart);
    // session_shutdown removes the pid file by design, so inspect before it: re-run without shutdown
    fs.rmSync(path.join(dir, "w1.firstActivation"), { force: true });
    await handlers["session_start"]({}, { ui, hasUI: false });
    const pidPresent = fs.existsSync(path.join(dir, "w1.pid"));
    console.log("pid file present after session_start:", pidPresent);
    await handlers["session_shutdown"]({}, {});
    expect(pidPresent).toBe(true);
  });
});
