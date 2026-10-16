// CLAIM S5: removeAgent accepts command lines that include the worker `--model` flag.
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ta from "../src/utils/terminal-adapter";
import { writeAgentRecord } from "../src/utils/registry";
import { AgentKind } from "../src/utils/models";
import { removeAgent } from "../src/utils/teams";

const SHAPES = [
  "node /Users/u/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/cli.js -ne -e '/x/extensions/index.ts' --model 'a/b'",
  "node '/usr/local/bin/pi' -ne -e '/x/extensions/index.ts' --model 'a/b':high",
  "pi -ne -e '/path with space/index.ts' --model 'a/b' --tools read,grep",
];

describe("S5 pid verification command shapes", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  for (const cmd of SHAPES) {
    it(`kills a worker whose ps command is: ${cmd.slice(0, 70)}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-kill-"));
      vi.stubEnv("TMPDIR", dir);
      writeAgentRecord({ id: "smoke111", kind: AgentKind.Teammate, cwd: dir, pid: 424242, leadId: "smoke222", name: "w", startedAt: 1 });
      vi.spyOn(ta, "execCommand").mockReturnValue({ stdout: cmd, stderr: "", status: 0 });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      await removeAgent({ agentId: "smoke111" });
      expect(kill).toHaveBeenCalledWith(424242, "SIGKILL");
    });
  }
});
