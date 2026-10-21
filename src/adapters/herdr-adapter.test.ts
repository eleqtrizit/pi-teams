/**
 * Herdr Adapter Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HerdrAdapter } from "./herdr-adapter";
import * as terminalAdapter from "../utils/terminal-adapter";

type Exec = { stdout: string; stderr: string; status: number | null };
const ok = (result: unknown = { type: "ok" }): Exec => ({ stdout: JSON.stringify({ result }), stderr: "", status: 0 });
const notFound: Exec = { stdout: "", stderr: '{"error":{"code":"pane_not_found"}}', status: 1 };
const splitResult = (paneId: string) => ok({ pane: { pane_id: paneId }, type: "pane_info" });

describe("HerdrAdapter", () => {
  let adapter: HerdrAdapter;
  let exec: ReturnType<typeof vi.spyOn>;
  const savedEnv = { ...process.env };

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
    const opts = {
      name: "alice",
      cwd: "/work",
      command: "pi --model 'a/b'",
      env: { PI_AGENT_ID: "abcd1234", HOME: "/home/x" },
    };

    it("splits the lead pane right, passes PI_ env, and execs the command", () => {
      exec.mockReturnValueOnce(splitResult("w1:p2")).mockReturnValueOnce(ok());

      expect(adapter.spawn(opts)).toBe("herdr_w1:p2");
      expect(exec.mock.calls[0]).toEqual([
        "herdr",
        ["pane", "split", "w1:p1", "--direction", "right", "--cwd", "/work",
          "--env", "PI_AGENT_ID=abcd1234", "--no-focus"],
      ]);
      expect(exec.mock.calls[1]).toEqual(["herdr", ["pane", "run", "w1:p2", "exec pi --model 'a/b'"]]);
    });

    it("stacks the next worker below the previous live worker pane", () => {
      exec
        .mockReturnValueOnce(splitResult("w1:p2"))
        .mockReturnValueOnce(ok())
        .mockReturnValueOnce(ok()) // pane get w1:p2
        .mockReturnValueOnce(splitResult("w1:p3"))
        .mockReturnValueOnce(ok());
      adapter.spawn(opts);

      expect(adapter.spawn({ ...opts, name: "bob" })).toBe("herdr_w1:p3");
      expect(exec.mock.calls[2]).toEqual(["herdr", ["pane", "get", "w1:p2"]]);
      expect(exec.mock.calls[3][1].slice(0, 5)).toEqual(["pane", "split", "w1:p2", "--direction", "down"]);
    });

    it("splits the lead pane right again when the previous worker pane is gone", () => {
      exec
        .mockReturnValueOnce(splitResult("w1:p2"))
        .mockReturnValueOnce(ok())
        .mockReturnValueOnce(notFound)
        .mockReturnValueOnce(splitResult("w1:p3"))
        .mockReturnValueOnce(ok());
      adapter.spawn(opts);
      adapter.spawn(opts);

      expect(exec.mock.calls[3][1].slice(0, 5)).toEqual(["pane", "split", "w1:p1", "--direction", "right"]);
    });

    it("throws when the split fails", () => {
      exec.mockReturnValueOnce({ stdout: "", stderr: "boom", status: 1 });
      expect(() => adapter.spawn(opts)).toThrow(/herdr pane split failed with status 1: boom/);
    });
  });

  describe("kill / isAlive", () => {
    it("closes a herdr pane", () => {
      exec.mockReturnValue(ok());
      adapter.kill("herdr_w1:p2");
      expect(exec).toHaveBeenCalledWith("herdr", ["pane", "close", "w1:p2"]);
    });

    it("ignores foreign and tab ids", () => {
      adapter.kill("%3");
      adapter.kill("herdr_tab_w1:t2");
      expect(exec).not.toHaveBeenCalled();
      expect(adapter.isAlive("iterm_x")).toBe(false);
    });

    it("reports liveness from pane get", () => {
      exec.mockReturnValueOnce(ok()).mockReturnValueOnce(notFound);
      expect(adapter.isAlive("herdr_w1:p2")).toBe(true);
      expect(adapter.isAlive("herdr_w1:p2")).toBe(false);
    });
  });

  describe("tabs as windows", () => {
    it("creates a labeled tab in the current workspace and runs the command in its root pane", () => {
      exec
        .mockReturnValueOnce(ok({ tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p4" }, type: "tab_created" }))
        .mockReturnValueOnce(ok());

      const id = adapter.spawnWindow({ name: "alice", cwd: "/work", command: "pi", env: { PI_X: "1" }, teamName: "t" });

      expect(id).toBe("herdr_tab_w1:t2");
      expect(exec.mock.calls[0]).toEqual([
        "herdr",
        ["tab", "create", "--workspace", "w1", "--cwd", "/work", "--label", "t: alice",
          "--env", "PI_X=1", "--no-focus"],
      ]);
      expect(exec.mock.calls[1]).toEqual(["herdr", ["pane", "run", "w1:p4", "exec pi"]]);
    });

    it("closes and probes tabs", () => {
      exec.mockReturnValueOnce(ok()).mockReturnValueOnce(notFound);
      adapter.killWindow("herdr_tab_w1:t2");
      expect(exec).toHaveBeenCalledWith("herdr", ["tab", "close", "w1:t2"]);
      expect(adapter.isWindowAlive("herdr_tab_w1:t2")).toBe(false);
      expect(adapter.isWindowAlive("herdr_w1:p2")).toBe(false);
    });
  });

  it("renames the current pane for setTitle", () => {
    exec.mockReturnValue(ok());
    adapter.setTitle("Agent: pi-teams");
    expect(exec).toHaveBeenCalledWith("herdr", ["pane", "rename", "w1:p1", "Agent: pi-teams"]);
  });
});
