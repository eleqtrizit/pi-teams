// CLAIM S6: with the poller now swallowing every error, one corrupt inbox file makes delivery fail forever with no signal.
// drainUndelivered throws on the same file on every tick, nothing quarantines it, nothing logs.
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../src/utils/paths";
import { drainUndelivered, appendMessage } from "../src/utils/messaging";

describe("S6 corrupt inbox", () => {
  afterEach(() => vi.restoreAllMocks());
  it("recovers (quarantine or reset) so later messages are delivered", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-inbox-"));
    const inbox = path.join(dir, "w.json");
    vi.spyOn(paths, "inboxPath").mockReturnValue(inbox);
    fs.writeFileSync(inbox, "{ not json");
    let failures = 0;
    for (let i = 0; i < 5; i++) { try { await drainUndelivered("t", "w"); } catch { failures++; } }
    console.log("consecutive failed ticks:", failures);
    await appendMessage("t", "w", { id: "1", from: "team-lead", to: "w", subject: "s", text: "t", timestamp: new Date().toISOString(), delivered: false }).catch(() => {});
    const out = await drainUndelivered("t", "w").catch(() => []);
    expect(out.length).toBe(1);
  });
});
