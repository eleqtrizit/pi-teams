// CLAIM S12: a message sent from one process reaches a listener in another process, immediately,
// and a sender gets an error as soon as that process exits.
import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RecipientUnreachableError, sendToAgent, waitForListener } from "../src/utils/transport";

const CHILD_SOURCE = path.resolve(__dirname, "helpers/listener_child.ts");
const ESBUILD = path.resolve(__dirname, "../node_modules/.bin/esbuild");
const AGENT_ID = "smoke123";
function bundleChild(dir: string): string {
  const bundle = path.join(dir, "listener_child.mjs");
  execFileSync(ESBUILD, [CHILD_SOURCE, "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`], { stdio: "pipe" });
  return bundle;
}

describe("S12 cross-process transport", () => {
  it("delivers across processes and fails fast after the listener exits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-xp-"));
    const out = path.join(dir, "received.txt");
    const child = spawn(process.execPath, [bundleChild(dir), AGENT_ID, out], { stdio: "inherit" });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    expect(await waitForListener(AGENT_ID, 15_000)).toBe(true);
    const started = Date.now();
    const message = (text: string) => ({
      id: "abcd1234", from: "sender11", to: AGENT_ID, fromLabel: "team-lead",
      subject: "s", text, timestamp: new Date().toISOString(),
    });
    await sendToAgent(message("first"));
    await sendToAgent(message("second"));
    console.log(`two cross-process sends took ${Date.now() - started} ms`);
    expect(fs.readFileSync(out, "utf-8")).toBe("first\nsecond\n");
    await sendToAgent(message("stop"));
    await exited;
    await expect(sendToAgent(message("late"))).rejects.toBeInstanceOf(RecipientUnreachableError);
  }, 30_000);
});
