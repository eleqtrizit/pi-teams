/**
 * Orca Adapter Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OrcaAdapter } from "./orca-adapter";
import * as terminalAdapter from "../utils/terminal-adapter";

describe("OrcaAdapter", () => {
  let adapter: OrcaAdapter;
  let mockExecCommand: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = new OrcaAdapter();
    mockExecCommand = vi.spyOn(terminalAdapter, "execCommand");
    process.env.TERM_PROGRAM = "Orca";
    process.env.ORCA_TERMINAL_HANDLE = "term_test-current";
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.TERM_PROGRAM;
    delete process.env.ORCA_TERMINAL_HANDLE;
  });

  describe("name", () => {
    it("should have the correct name", () => {
      expect(adapter.name).toBe("Orca");
    });
  });

  describe("detect", () => {
    it("should detect when TERM_PROGRAM is Orca", () => {
      process.env.TERM_PROGRAM = "Orca";
      expect(adapter.detect()).toBe(true);
    });

    it("should not detect when TERM_PROGRAM is not Orca", () => {
      process.env.TERM_PROGRAM = "iTerm.app";
      expect(adapter.detect()).toBe(false);
    });

    it("should not detect when TERM_PROGRAM is unset", () => {
      delete process.env.TERM_PROGRAM;
      expect(adapter.detect()).toBe(false);
    });
  });

  describe("spawn", () => {
    it("should create a terminal and return orca_<handle>", () => {
      const mockResponse = {
        ok: true,
        result: {
          terminal: {
            handle: "term_abc123",
            tabId: "tab_1",
            title: "test-team: test-agent",
          },
        },
      };
      mockExecCommand.mockReturnValue({
        stdout: JSON.stringify(mockResponse),
        stderr: "",
        status: 0,
      });

      const result = adapter.spawn({
        name: "test-agent",
        cwd: "/home/user/project",
        command: "pi --model test",
        env: { PI_AGENT_ID: "test-123" },
        teamName: "test-team",
      });

      expect(result).toBe("orca_term_abc123");
      expect(mockExecCommand).toHaveBeenCalledWith(
        "orca",
        expect.arrayContaining([
          "terminal", "create",
          "--worktree", "active",
          "--title", "test-team: test-agent",
        ]),
      );
    });

    it("should prefix PI_ env vars into the command", () => {
      const mockResponse = {
        ok: true,
        result: { terminal: { handle: "term_xyz" } },
      };
      mockExecCommand.mockReturnValue({
        stdout: JSON.stringify(mockResponse),
        stderr: "",
        status: 0,
      });

      adapter.spawn({
        name: "agent1",
        cwd: "/repo",
        command: "pi",
        env: { PI_TEAM_NAME: "myteam", PI_AGENT_NAME: "agent1", OTHER_VAR: "skip" },
      });

      const callArgs = mockExecCommand.mock.calls[0][1] as string[];
      const commandIdx = callArgs.indexOf("--command");
      expect(commandIdx).toBeGreaterThan(-1);
      const cmd = callArgs[commandIdx + 1];
      expect(cmd).toContain("env PI_TEAM_NAME=myteam PI_AGENT_NAME=agent1 pi");
      expect(cmd).not.toContain("OTHER_VAR");
    });

    it("should not prefix env when no PI_ vars present", () => {
      const mockResponse = {
        ok: true,
        result: { terminal: { handle: "term_xyz" } },
      };
      mockExecCommand.mockReturnValue({
        stdout: JSON.stringify(mockResponse),
        stderr: "",
        status: 0,
      });

      adapter.spawn({
        name: "agent1",
        cwd: "/repo",
        command: "pi",
        env: { OTHER_VAR: "skip" },
      });

      const callArgs = mockExecCommand.mock.calls[0][1] as string[];
      const commandIdx = callArgs.indexOf("--command");
      const cmd = callArgs[commandIdx + 1];
      expect(cmd).toBe("pi");
    });

    it("should use agent name as title when no teamName", () => {
      const mockResponse = {
        ok: true,
        result: { terminal: { handle: "term_xyz" } },
      };
      mockExecCommand.mockReturnValue({
        stdout: JSON.stringify(mockResponse),
        stderr: "",
        status: 0,
      });

      adapter.spawn({
        name: "worker1",
        cwd: "/repo",
        command: "pi",
        env: {},
      });

      expect(mockExecCommand).toHaveBeenCalledWith(
        "orca",
        expect.arrayContaining(["--title", "worker1"]),
      );
    });

    it("should throw on non-zero exit status", () => {
      mockExecCommand.mockReturnValue({
        stdout: "",
        stderr: "some error",
        status: 1,
      });

      expect(() =>
        adapter.spawn({
          name: "agent1",
          cwd: "/repo",
          command: "pi",
          env: {},
        }),
      ).toThrow("failed with status 1");
    });

    it("should throw on invalid JSON response", () => {
      mockExecCommand.mockReturnValue({
        stdout: "not json",
        stderr: "",
        status: 0,
      });

      expect(() =>
        adapter.spawn({
          name: "agent1",
          cwd: "/repo",
          command: "pi",
          env: {},
        }),
      ).toThrow();
    });

    it("should throw when response is not ok", () => {
      mockExecCommand.mockReturnValue({
        stdout: JSON.stringify({ ok: false, error: "boom" }),
        stderr: "",
        status: 0,
      });

      expect(() =>
        adapter.spawn({
          name: "agent1",
          cwd: "/repo",
          command: "pi",
          env: {},
        }),
      ).toThrow("unexpected response");
    });
  });

  describe("kill", () => {
    it("should call orca terminal close with the correct handle", () => {
      mockExecCommand.mockReturnValue({
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
        status: 0,
      });

      adapter.kill("orca_term_abc123");

      expect(mockExecCommand).toHaveBeenCalledWith(
        "orca",
        expect.arrayContaining([
          "terminal", "close",
          "--terminal", "term_abc123",
          "--json",
        ]),
      );
    });

    it("should be a no-op for non-orca pane IDs", () => {
      adapter.kill("wezterm_1");
      adapter.kill("iterm_2");
      adapter.kill("zellij_3");
      adapter.kill("");
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it("should swallow errors gracefully", () => {
      mockExecCommand.mockImplementation(() => {
        throw new Error("command failed");
      });

      expect(() => adapter.kill("orca_term_abc")).not.toThrow();
    });
  });

  describe("isAlive", () => {
    it("should return true when handle exists in terminal list", () => {
      const mockList = {
        ok: true,
        result: {
          terminals: [
            { handle: "term_aaa" },
            { handle: "term_bbb" },
          ],
        },
      };
      mockExecCommand.mockReturnValue({
        stdout: JSON.stringify(mockList),
        stderr: "",
        status: 0,
      });

      expect(adapter.isAlive("orca_term_bbb")).toBe(true);
    });

    it("should return false when handle does not exist", () => {
      const mockList = {
        ok: true,
        result: { terminals: [{ handle: "term_aaa" }] },
      };
      mockExecCommand.mockReturnValue({
        stdout: JSON.stringify(mockList),
        stderr: "",
        status: 0,
      });

      expect(adapter.isAlive("orca_term_zzz")).toBe(false);
    });

    it("should return false for non-orca pane IDs", () => {
      expect(adapter.isAlive("wezterm_1")).toBe(false);
      expect(adapter.isAlive("")).toBe(false);
    });

    it("should return false on command failure", () => {
      mockExecCommand.mockReturnValue({
        stdout: "",
        stderr: "error",
        status: 1,
      });

      expect(adapter.isAlive("orca_term_abc")).toBe(false);
    });

    it("should return false on JSON parse failure", () => {
      mockExecCommand.mockReturnValue({
        stdout: "not json",
        stderr: "",
        status: 0,
      });

      expect(adapter.isAlive("orca_term_abc")).toBe(false);
    });
  });

  describe("setTitle", () => {
    it("should call orca terminal rename with the current terminal handle", () => {
      process.env.ORCA_TERMINAL_HANDLE = "term_current123";

      adapter.setTitle("New Title");

      expect(mockExecCommand).toHaveBeenCalledWith(
        "orca",
        expect.arrayContaining([
          "terminal", "rename",
          "--terminal", "term_current123",
          "--title", "New Title",
          "--json",
        ]),
      );
    });

    it("should be a no-op when ORCA_TERMINAL_HANDLE is not set", () => {
      delete process.env.ORCA_TERMINAL_HANDLE;

      adapter.setTitle("Title");

      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it("should swallow errors gracefully", () => {
      mockExecCommand.mockImplementation(() => {
        throw new Error("command failed");
      });

      expect(() => adapter.setTitle("Title")).not.toThrow();
    });
  });

  describe("supportsWindows", () => {
    it("should return false", () => {
      expect(adapter.supportsWindows()).toBe(false);
    });
  });

  describe("spawnWindow", () => {
    it("should throw an error", () => {
      expect(() =>
        adapter.spawnWindow({
          name: "test",
          cwd: "/repo",
          command: "pi",
          env: {},
        }),
      ).toThrow("does not support");
    });
  });

  describe("window methods", () => {
    it("killWindow should be a no-op", () => {
      expect(() => adapter.killWindow("orca_win_1")).not.toThrow();
    });

    it("setWindowTitle should be a no-op", () => {
      expect(() =>
        adapter.setWindowTitle("orca_win_1", "Title"),
      ).not.toThrow();
    });

    it("isWindowAlive should return false", () => {
      expect(adapter.isWindowAlive("orca_win_1")).toBe(false);
    });
  });
});
