/**
 * Herdr Adapter Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HerdrAdapter } from "./herdr-adapter";
import * as terminalAdapter from "../utils/terminal-adapter";

type Exec = { stdout: string; stderr: string; status: number | null };
const ok = (result: unknown = { type: "ok" }): Exec => ({ stdout: JSON.stringify({ result }), stderr: "", status: 0 });
const notFound: Exec = { stdout: "", stderr: '{"error":{"code":"tab_not_found"}}', status: 1 };
const tabCreated = (tabId: string, paneId: string) =>
  ok({ tab: { tab_id: tabId }, root_pane: { pane_id: paneId }, type: "tab_created" });

describe("HerdrAdapter", () => {
  let adapter: HerdrAdapter;
  let exec: ReturnType<typeof vi.spyOn>;
  const savedEnv = { ...process.env };
  const opts = {
    name: "alice",
    cwd: "/work",
    command: "pi --model 'a/b'",
    env: { PI_AGENT_ID: "abcd1234", HOME: "/home/x" },
  };

  beforeEach(() => {
    adapter = new HerdrAdapter();
    exec = vi.spyOn(terminalAdapter, "execCommand");
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.HERDR_WORKSPACE_ID = "w1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  describe("detect", () => {
    it("detects a herdr pane", () => {
      expect(adapter.detect()).toBe(true);
    });

    it("rejects when HERDR_PANE_ID is missing", () => {
      delete process.env.HERDR_PANE_ID;
      expect(adapter.detect()).toBe(false);
    });

    it("rejects when HERDR_ENV is unset", () => {
      delete process.env.HERDR_ENV;
      expect(adapter.detect()).toBe(false);
    });
  });

  describe("spawn", () => {
    it("opens a labeled tab in the lead's workspace, passes PI_ env, and execs the command", () => {
      exec.mockReturnValueOnce(tabCreated("w1:t2", "w1:p4")).mockReturnValueOnce(ok());

      expect(adapter.spawn(opts)).toBe("herdr_tab_w1:t2");
      expect(exec.mock.calls[0]).toEqual([
        "herdr",
        ["tab", "create", "--workspace", "w1", "--cwd", "/work", "--label", "alice",
          "--env", "PI_AGENT_ID=abcd1234", "--no-focus"],
      ]);
      expect(exec.mock.calls[1]).toEqual(["herdr", ["pane", "run", "w1:p4", "exec pi --model 'a/b'"]]);
    });

    it("prefixes the label with the team name", () => {
      exec.mockReturnValueOnce(tabCreated("w1:t2", "w1:p4")).mockReturnValueOnce(ok());
      adapter.spawn({ ...opts, teamName: "t" });
      expect(exec.mock.calls[0][1]).toContain("t: alice");
    });

    it("omits --workspace outside a herdr workspace", () => {
      delete process.env.HERDR_WORKSPACE_ID;
      exec.mockReturnValueOnce(tabCreated("w1:t2", "w1:p4")).mockReturnValueOnce(ok());
      adapter.spawn(opts);
      expect(exec.mock.calls[0][1]).not.toContain("--workspace");
    });

    it("throws when tab creation fails", () => {
      exec.mockReturnValueOnce({ stdout: "", stderr: "boom", status: 1 });
      expect(() => adapter.spawn(opts)).toThrow(/herdr tab create failed with status 1: boom/);
    });

    it("throws when the command cannot start", () => {
      exec.mockReturnValueOnce(tabCreated("w1:t2", "w1:p4")).mockReturnValueOnce({ stdout: "", stderr: "x", status: 1 });
      expect(() => adapter.spawn(opts)).toThrow(/herdr pane run failed/);
    });
  });

  it("spawnWindow opens the same tab as spawn", () => {
    exec.mockReturnValueOnce(tabCreated("w1:t3", "w1:p5")).mockReturnValueOnce(ok());
    expect(adapter.spawnWindow(opts)).toBe("herdr_tab_w1:t3");
    expect(exec.mock.calls[0][1].slice(0, 2)).toEqual(["tab", "create"]);
  });

  describe("kill / isAlive", () => {
    it("closes the tab through both kill and killWindow", () => {
      exec.mockReturnValue(ok());
      adapter.kill("herdr_tab_w1:t2");
      adapter.killWindow("herdr_tab_w1:t3");
      expect(exec.mock.calls).toEqual([
        ["herdr", ["tab", "close", "w1:t2"]],
        ["herdr", ["tab", "close", "w1:t3"]],
      ]);
    });

    it("ignores ids owned by other adapters", () => {
      adapter.kill("%3");
      adapter.killWindow("iterm_x");
      expect(exec).not.toHaveBeenCalled();
      expect(adapter.isAlive("zellij_x")).toBe(false);
      expect(adapter.isWindowAlive("orca_x")).toBe(false);
    });

    it("reports liveness from tab get", () => {
      exec.mockReturnValueOnce(ok()).mockReturnValueOnce(notFound);
      expect(adapter.isAlive("herdr_tab_w1:t2")).toBe(true);
      expect(adapter.isWindowAlive("herdr_tab_w1:t2")).toBe(false);
      expect(exec).toHaveBeenCalledWith("herdr", ["tab", "get", "w1:t2"]);
    });
  });

  it("renames the current pane for setTitle", () => {
    exec.mockReturnValue(ok());
    adapter.setTitle("pi-teams: abcd1234");
    expect(exec).toHaveBeenCalledWith("herdr", ["pane", "rename", "w1:p1", "pi-teams: abcd1234"]);
  });

  it("renames a tab for setWindowTitle", () => {
    exec.mockReturnValue(ok());
    adapter.setWindowTitle("herdr_tab_w1:t2", "bob");
    expect(exec).toHaveBeenCalledWith("herdr", ["tab", "rename", "w1:t2", "bob"]);
  });
});
