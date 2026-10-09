// CLAIM S9: the pid check /(^|\/)pi(\s|:|$)/ matches any process whose command line contains a path component named "pi",
// e.g. an editor opened on /Users/u/repos/pi. A recycled pid owned by such a process is SIGKILLed.
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ta from "../src/utils/terminal-adapter";
import * as paths from "../src/utils/paths";
import { removeAgent } from "../src/utils/teams";

const UNRELATED = ["vim /Users/u/repos/pi", "/usr/bin/tail -f /var/log/pi", "code /home/u/pi --reuse-window"];

describe("S9 pid verification false positives", () => {
  afterEach(() => vi.restoreAllMocks());
  for (const cmd of UNRELATED) {
    it(`does not kill unrelated: ${cmd}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-fp-"));
      vi.spyOn(paths, "teamDir").mockReturnValue(dir);
      vi.spyOn(paths, "configPath").mockReturnValue(path.join(dir, "config.json"));
      for (const fn of ["pidPath", "activePath", "lastReportPath", "lastReminderPath", "firstActivationPath"] as const) {
        vi.spyOn(paths, fn).mockImplementation((_t: string, a: string) => path.join(dir, `${a}.${fn}`));
      }
      vi.spyOn(paths, "inboxPath").mockImplementation((_t, a) => path.join(dir, `${a}.json`));
      fs.writeFileSync(path.join(dir, "w.pidPath"), "424242");
      vi.spyOn(ta, "execCommand").mockReturnValue({ stdout: cmd, stderr: "", status: 0 });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      await removeAgent({ team: "t", agentName: "w" });
      expect(kill).not.toHaveBeenCalled();
    });
  }
});
