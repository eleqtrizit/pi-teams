// CLAIM S5 (conditional): removeAgent skips SIGKILL unless `ps` output matches /(^|\/)pi(\s|:|$)/.
// Workers are launched as `node <argv[1]> ...`. If the process title is not rewritten to `pi`, ps shows the script path.
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ta from "../src/utils/terminal-adapter";
import * as paths from "../src/utils/paths";
import { removeAgent } from "../src/utils/teams";

const SHAPES = [
  "node /Users/u/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/cli.js -ne -e '/x/extensions/index.ts' --model 'a/b'",
  "node '/usr/local/bin/pi' -ne -e '/x/extensions/index.ts' --model 'a/b':high",
  "pi -ne -e '/path with space/index.ts' --model 'a/b' --tools read,grep",
];

describe("S5 pid verification command shapes", () => {
  afterEach(() => vi.restoreAllMocks());
  for (const cmd of SHAPES) {
    it(`kills a worker whose ps command is: ${cmd.slice(0, 70)}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-kill-"));
      vi.spyOn(paths, "teamDir").mockReturnValue(dir);
      vi.spyOn(paths, "configPath").mockReturnValue(path.join(dir, "config.json"));
      for (const fn of ["pidPath", "activePath", "firstActivationPath"] as const) {
        vi.spyOn(paths, fn).mockImplementation((_t: string, a: string) => path.join(dir, `${a}.${fn}`));
      }
      vi.spyOn(paths, "socketPath").mockImplementation((_t, a) => path.join(dir, `${a}.sock`));
      fs.writeFileSync(path.join(dir, "w.pidPath"), "424242");
      vi.spyOn(ta, "execCommand").mockReturnValue({ stdout: cmd, stderr: "", status: 0 });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      await removeAgent({ team: "t", agentName: "w" });
      expect(kill).toHaveBeenCalledWith(424242, "SIGKILL");
    });
  }
});
