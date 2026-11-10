/**
 * Herdr-Core Adapter Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HerdrCoreAdapter } from "./herdr-core-adapter";
import * as terminalAdapter from "../utils/terminal-adapter";

type Exec = { stdout: string; stderr: string; status: number | null };
const ok = (stdout: string): Exec => ({ stdout, stderr: "", status: 0 });
const fail: Exec = { stdout: "", stderr: '{"error":{"kind":"not_found"}}', status: 1 };

const hcRunResult = (address: string) =>
  ok(JSON.stringify({ terminal: { address, name: "alice-abcd1234", state: "live" }, first_message: null, wait: null, output: null }));
const appLs = (tabId: string, ...terminals: string[]) =>
  ok(JSON.stringify({ spaces: [{ id: "sp1", tabs: [{ id: tabId, terminals: terminals.map((t) => ({ terminal: t })) }] }] }));

describe("HerdrCoreAdapter", () => {
  let adapter: HerdrCoreAdapter;
  let exec: ReturnType<typeof vi.spyOn>;
  const savedEnv = { ...process.env };
  const opts = {
    name: "alice",
    cwd: "/work",
    command: "pi --model 'a/b'",
    env: { PI_AGENT_ID: "abcd1234", HOME: "/home/x" },
  };

  beforeEach(() => {
    adapter = new HerdrCoreAdapter();
    exec = vi.spyOn(terminalAdapter, "execCommand");
    process.env.HC_TERMINAL_ID = "t1d";
    process.env.HC_TERMINAL_SOCKET = "/tmp/herdr-core/default.sock";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  describe("detect", () => {
    it("detects a herdr-core terminal", () => {
      expect(adapter.detect()).toBe(true);
    });

    it("detects even alongside herdr app vars, so the core adapter wins registration order", () => {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_PANE_ID = "w8:p1";
      expect(adapter.detect()).toBe(true);
    });

    it("rejects when HC_TERMINAL_SOCKET is missing", () => {
      delete process.env.HC_TERMINAL_SOCKET;
      expect(adapter.detect()).toBe(false);
    });

    it("rejects when HC_TERMINAL_ID is missing", () => {
      delete process.env.HC_TERMINAL_ID;
      expect(adapter.detect()).toBe(false);
    });
  });

  describe("spawn", () => {
    it("starts a labeled terminal with PI_ env in the command line and execs the command", () => {
      exec.mockReturnValueOnce(appLs("tb1", "t1d")).mockReturnValueOnce(hcRunResult("t12"));

      expect(adapter.spawn(opts)).toBe("hc_t12");
      expect(exec.mock.calls[0]).toEqual(["herdr-app", ["ls"]]);
      expect(exec.mock.calls[1]).toEqual([
        "hc",
        ["run", "--bg", "--json", "--name", "alice-abcd1234", "--cwd", "/work", "--no-notify", "--outlive-parent", "--rm",
          "--label", "herdr.space=sp1", "PI_AGENT_ID='abcd1234' exec pi --model 'a/b'"],
      ]);
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it("labels with the space showing the lead's terminal, not the active space", () => {
      const ls = ok(JSON.stringify({
        spaces: [
          { id: "spActive", active: true, tabs: [{ id: "tb9", terminals: [{ terminal: "t99" }] }] },
          { id: "spLead", active: false, tabs: [{ id: "tb1", terminals: [{ terminal: "t1d" }] }] },
        ],
      }));
      exec.mockReturnValueOnce(ls).mockReturnValueOnce(hcRunResult("t13")).mockReturnValueOnce(ls).mockReturnValueOnce(hcRunResult("t14"));

      adapter.spawn(opts);
      expect(exec.mock.calls[1][1]).toContain("herdr.space=spLead");

      // The space is looked up again on every spawn, never cached.
      adapter.spawn(opts);
      expect(exec.mock.calls[2]).toEqual(["herdr-app", ["ls"]]);
      expect(exec.mock.calls[3][1]).toContain("herdr.space=spLead");
    });

    it("spawns unlabeled when the lead's terminal has no pane in the window", () => {
      exec.mockReturnValueOnce(appLs("tb1", "t99")).mockReturnValueOnce(hcRunResult("t14"));

      expect(adapter.spawn(opts)).toBe("hc_t14");
      expect(exec.mock.calls[1][1]).not.toContain("--label");
    });

    it("spawns unlabeled when no herdr-app window is open", () => {
      exec.mockReturnValueOnce(fail).mockReturnValueOnce(hcRunResult("t14"));

      expect(adapter.spawn(opts)).toBe("hc_t14");
      expect(exec.mock.calls[1][1]).not.toContain("--label");
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it("spawns unlabeled when herdr-app is not installed", () => {
      exec.mockReturnValueOnce({ stdout: "", stderr: "", status: null }).mockReturnValueOnce(hcRunResult("t15"));

      expect(adapter.spawn(opts)).toBe("hc_t15");
      expect(exec.mock.calls[1][1]).not.toContain("--label");
    });

    it("spawns unlabeled when herdr-app ls prints no JSON", () => {
      exec.mockReturnValueOnce(ok("not json")).mockReturnValueOnce(hcRunResult("t16"));

      expect(adapter.spawn(opts)).toBe("hc_t16");
      expect(exec.mock.calls[1][1]).not.toContain("--label");
    });

    it("sanitizes and length-caps the hc terminal name", () => {
      exec
        .mockReturnValueOnce(fail)
        .mockReturnValueOnce(hcRunResult("t17"))
        .mockReturnValueOnce(fail)
        .mockReturnValueOnce(hcRunResult("t18"));
      const nameAt = (call: number) => {
        const argv = exec.mock.calls[call][1] as string[];
        return argv[argv.indexOf("--name") + 1];
      };

      adapter.spawn({ ...opts, name: "Reviewer #2 (fast)" });
      expect(nameAt(1)).toBe("reviewer-2-fast-abcd1234");

      adapter.spawn({ ...opts, name: "x".repeat(80) });
      const name = nameAt(3);
      expect(name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(name.endsWith("-abcd1234")).toBe(true);

      exec.mockReturnValueOnce(fail).mockReturnValueOnce(hcRunResult("t19"));
      adapter.spawn({ ...opts, name: `${"y".repeat(22)} tail` });
      expect(nameAt(5)).toBe(`${"y".repeat(22)}-abcd1234`);
    });

    it("uses the plain name without an agent id", () => {
      exec.mockReturnValueOnce(fail).mockReturnValueOnce(hcRunResult("t18"));

      adapter.spawn({ ...opts, env: { HOME: "/home/x" } });
      const argv = exec.mock.calls[1][1] as string[];
      expect(argv[argv.indexOf("--name") + 1]).toBe("alice");
      expect(argv[argv.length - 1]).toBe("exec pi --model 'a/b'");
    });

    it("throws when the launch fails", () => {
      exec.mockReturnValueOnce(fail).mockReturnValueOnce(fail);
      expect(() => adapter.spawn(opts)).toThrow(/hc run --bg failed with status 1/);
    });

    it("throws when the response has no terminal address", () => {
      exec.mockReturnValueOnce(fail).mockReturnValueOnce(ok(JSON.stringify({ first_message: null })));
      expect(() => adapter.spawn(opts)).toThrow(/hc run returned unexpected response/);
    });

    it("parses the terminal object when returned at the top level", () => {
      exec.mockReturnValueOnce(fail).mockReturnValueOnce(ok(JSON.stringify({ address: "t20", state: "live" })));

      expect(adapter.spawn(opts)).toBe("hc_t20");
    });
  });

  it("spawnWindow starts the same terminal as spawn", () => {
    exec.mockReturnValueOnce(fail).mockReturnValueOnce(hcRunResult("t19"));

    expect(adapter.spawnWindow(opts)).toBe("hc_t19");
    expect(exec.mock.calls[1][0]).toBe("hc");
    expect((exec.mock.calls[1][1] as string[]).slice(0, 2)).toEqual(["run", "--bg"]);
  });

  describe("kill / isAlive", () => {
    it("kills and removes the terminal through both kill and killWindow", () => {
      exec.mockReturnValue(ok("{}"));
      adapter.kill("hc_t12");
      adapter.killWindow("hc_t13");
      expect(exec.mock.calls).toEqual([
        ["hc", ["kill", "t12"]],
        ["hc", ["rm", "t12"]],
        ["hc", ["kill", "t13"]],
        ["hc", ["rm", "t13"]],
      ]);
    });

    it("ignores ids owned by other adapters", () => {
      adapter.kill("%3");
      adapter.killWindow("iterm_x");
      expect(exec).not.toHaveBeenCalled();
      expect(adapter.isAlive("herdr_tab_w1:t2")).toBe(false);
      expect(adapter.isWindowAlive("zellij_x")).toBe(false);
    });

    it("reports liveness from the terminal state", () => {
      exec
        .mockReturnValueOnce(ok(JSON.stringify({ address: "t12", state: "live" })))
        .mockReturnValueOnce(ok(JSON.stringify({ address: "t12", state: "finished", exit_code: 0 })))
        .mockReturnValueOnce(fail);
      expect(adapter.isAlive("hc_t12")).toBe(true);
      expect(adapter.isAlive("hc_t12")).toBe(false);
      expect(adapter.isWindowAlive("hc_t12")).toBe(false);
      expect(exec).toHaveBeenCalledWith("hc", ["get", "--json", "t12"]);
    });

    it("treats unparsable output as dead", () => {
      exec.mockReturnValueOnce(ok("not json"));
      expect(adapter.isAlive("hc_t12")).toBe(false);
    });
  });

  describe("titles", () => {
    it("renames the session's own tab for setTitle and reuses the lookup", () => {
      exec
        .mockReturnValueOnce(appLs("tb1", "t1d", "t12"))
        .mockReturnValueOnce(ok("{}"))
        .mockReturnValueOnce(ok("{}"));

      adapter.setTitle("pi-teams: abcd1234");
      adapter.setTitle("Idle");
      expect(exec).toHaveBeenCalledTimes(3);
      expect(exec.mock.calls[0]).toEqual(["herdr-app", ["ls"]]);
      expect(exec.mock.calls[1]).toEqual(["herdr-app", ["do", "tab.rename", "--id", "tb1", "--name", "pi-teams: abcd1234"]]);
      expect(exec.mock.calls[2]).toEqual(["herdr-app", ["do", "tab.rename", "--id", "tb1", "--name", "Idle"]]);
    });

    it("skips setTitle when the window is closed", () => {
      exec.mockReturnValueOnce(fail);
      adapter.setTitle("x");
      expect(exec).toHaveBeenCalledTimes(1);
    });

    it("skips setTitle when the own terminal has no tab in the window", () => {
      exec.mockReturnValueOnce(appLs("tb1", "t99"));
      adapter.setTitle("x");
      expect(exec).toHaveBeenCalledTimes(1);
    });

    it("renames a worker tab for setWindowTitle", () => {
      exec.mockReturnValueOnce(appLs("tb2", "t12")).mockReturnValueOnce(ok("{}"));

      adapter.setWindowTitle("hc_t12", "bob");
      expect(exec.mock.calls[0]).toEqual(["herdr-app", ["ls"]]);
      expect(exec.mock.calls[1]).toEqual(["herdr-app", ["do", "tab.rename", "--id", "tb2", "--name", "bob"]]);
    });

    it("skips setWindowTitle for ids owned by other adapters", () => {
      adapter.setWindowTitle("iterm_x", "bob");
      expect(exec).not.toHaveBeenCalled();
    });
  });

  it("supports windows as tabs", () => {
    expect(adapter.supportsWindows()).toBe(true);
  });
});
