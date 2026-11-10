/**
 * Live integration check for HerdrCoreAdapter. Opt-in: it opens a real tab
 * in the herdr-app window, so it runs only with HC_LIVE_TEST=1 inside a
 * herdr-core terminal (HC_TERMINAL_* set):
 *
 *   HC_LIVE_TEST=1 npx vitest run src/adapters/herdr-core-adapter.live.test.ts
 *
 * Runs the real adapter against the real hc/herdr-app CLIs and cleans up after itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HerdrCoreAdapter } from "./herdr-core-adapter";
import * as terminalAdapter from "../utils/terminal-adapter";

const live =
  process.env.HC_LIVE_TEST === "1" && !!process.env.HC_TERMINAL_ID && !!process.env.HC_TERMINAL_SOCKET;
const d = live ? describe : describe.skip;

/** A sandboxed runner cannot PATH-resolve the hc/herdr-app symlinks (EPERM), so prefer the absolute target. */
function bin(command: string): string {
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const abs = `${process.env.HOME}/.local/bin/${command}`;
  return existsSync(abs) ? abs : command;
}

d("HerdrCoreAdapter LIVE", () => {
  beforeEach(() => {
    vi.spyOn(terminalAdapter, "execCommand").mockImplementation(((command: string, args: string[]) => {
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      return spawnSync(bin(command), args, { encoding: "utf-8" });
    }) as typeof terminalAdapter.execCommand);
  });
  afterEach(() => vi.restoreAllMocks());

  it("detects, spawns, relabels, and kills a real terminal", () => {
    const adapter = new HerdrCoreAdapter();
    expect(adapter.detect()).toBe(true);

    const agentId = `live${Date.now() % 100000}`.padEnd(8, "0");
    let id = "";
    try {
      id = adapter.spawn({
        name: "livecheck",
        cwd: "/tmp",
        command: "sleep 60",
        env: { PI_AGENT_ID: agentId, PI_AGENT_NAME: "livecheck" },
      });
      expect(id).toMatch(/^hc_t/);

      // The herdr-app window should show a tab for the new terminal; the
      // window attaches a pane shortly after the spawn, so poll for it.
      // It must land in the space that shows this session's own terminal.
      const holds = (s: any, terminal: string) =>
        s.tabs.some((t: any) => t.terminals.some((x: any) => x.terminal === terminal));
      let found = false;
      for (let attempt = 0; attempt < 10 && !found; attempt++) {
        const ls = JSON.parse(execHerdrApp(["ls"]));
        found = ls.spaces.some((s: any) => holds(s, id.slice(3)) && holds(s, process.env.HC_TERMINAL_ID!));
        if (!found) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
      expect(found).toBe(true);

      expect(adapter.isAlive(id)).toBe(true);
    } finally {
      if (id) {
        adapter.kill(id);
        expect(adapter.isAlive(id)).toBe(false);
        // kill() removes the finished terminal from the core as well.
        const all = JSON.parse(execHcOut(["ls", "--all", "--json"]));
        const leftover = all.terminals.some((t: any) => t.address === id.slice(3));
        execHc(["rm", id.slice(3)]);
        expect(leftover).toBe(false);
      }
    }
  }, 30_000);
});

function execHc(args: string[]): void {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    execFileSync(bin("hc"), args, { encoding: "utf-8", stdio: "pipe" });
  } catch {
    // Already removed or the address is gone.
  }
}

function execHcOut(args: string[]): string {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  return execFileSync(bin("hc"), args, { encoding: "utf-8" });
}

function execHerdrApp(args: string[]): string {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  return execFileSync(bin("herdr-app"), args, { encoding: "utf-8" });
}
