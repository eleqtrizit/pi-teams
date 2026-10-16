// CLAIM S13: a listener killed with SIGKILL leaves a stale socket file; senders fail at once,
// and a restarted listener takes the address over.
import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentSocketPath } from "../src/utils/paths";
import { RecipientUnreachableError, sendToAgent, startListener, waitForListener } from "../src/utils/transport";

const CHILD_SOURCE = path.resolve(__dirname, "helpers/listener_child.ts");
const ESBUILD = path.resolve(__dirname, "../node_modules/.bin/esbuild");
const AGENT_ID = "smoke137";

describe("S13 killed listener", () => {
  it("fails fast on a stale socket file and recovers after a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-kill-"));
    const bundle = path.join(dir, "child.mjs");
    execFileSync(ESBUILD, [CHILD_SOURCE, "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`], { stdio: "pipe" });
    const child = spawn(process.execPath, [bundle, AGENT_ID, path.join(dir, "out.txt")], { stdio: "inherit" });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    expect(await waitForListener(AGENT_ID, 15_000)).toBe(true);
    child.kill("SIGKILL");
    await exited;
    expect(fs.existsSync(agentSocketPath(AGENT_ID))).toBe(true);
    const message = { id: "abcd1234", from: "sender11", to: AGENT_ID, fromLabel: "team-lead", subject: "s", text: "hi", timestamp: new Date().toISOString() };
    const started = Date.now();
    await expect(sendToAgent(message)).rejects.toBeInstanceOf(RecipientUnreachableError);
    console.log(`send to a killed listener failed in ${Date.now() - started} ms`);
    const received: string[] = [];
    const listener = await startListener(AGENT_ID, (incoming) => { received.push(incoming.text); });
    try {
      await sendToAgent(message);
      expect(received).toEqual(["hi"]);
    } finally {
      await listener.close();
    }
  }, 30_000);
});
