// CLAIM S4: list_teammates reports every Zellij worker as dead because ZellijAdapter.isAlive now always returns false
// and list_teammates uses terminal.isAlive only (no pid-file check).
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as teams from "../src/utils/teams";
import * as paths from "../src/utils/paths";
import theExtension from "../extensions/index";

describe("S4 list_teammates on Zellij", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("reports a running worker as alive", async () => {
    vi.stubEnv("ZELLIJ", "1");
    vi.stubEnv("TMUX", "");
    vi.stubEnv("TERM_PROGRAM", "");
    vi.stubEnv("WEZTERM_PANE", "");
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-zj-"));
    fs.writeFileSync(path.join(dir, "w1.pid"), String(process.pid)); // live worker pid
    vi.spyOn(paths, "pidPath").mockImplementation((_t, a) => path.join(dir, `${a}.pid`));
    vi.spyOn(paths, "activePath").mockImplementation((_t, a) => path.join(dir, `${a}.active`));
    vi.spyOn(teams, "readConfig").mockResolvedValue({
      name: "t", members: [{ name: "w1", agentType: "teammate", tmuxPaneId: "zellij_w1", subscriptions: [] }],
    } as any);

    const tools: Record<string, any> = {};
    theExtension({
      on: vi.fn(), registerCommand: vi.fn(), registerEntryRenderer: vi.fn(), sendUserMessage: vi.fn(),
      registerTool: (t: any) => { tools[t.name] = t; },
    } as any);
    const res = await tools["list_teammates"].execute("id", { team_name: "t" }, undefined, undefined, {});
    console.log(JSON.stringify(res.details.teammates));
    expect(res.details.teammates[0].alive).toBe(true);
  });
});
