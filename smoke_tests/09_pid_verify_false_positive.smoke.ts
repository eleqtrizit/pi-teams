// CLAIM S9: registry PID verification skips unrelated commands that lack the worker `--model` flag.
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ta from "../src/utils/terminal-adapter";
import { writeAgentRecord } from "../src/utils/registry";
import { AgentKind } from "../src/utils/models";
import { removeAgent } from "../src/utils/teams";

const UNRELATED = ["vim /Users/u/repos/pi", "/usr/bin/tail -f /var/log/pi", "code /home/u/pi --reuse-window"];

describe("S9 pid verification false positives", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  for (const cmd of UNRELATED) {
    it(`does not kill unrelated: ${cmd}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-fp-"));
      vi.stubEnv("TMPDIR", dir);
      writeAgentRecord({ id: "smoke111", kind: AgentKind.Teammate, cwd: dir, pid: 424242, leadId: "smoke222", name: "w", startedAt: 1 });
      vi.spyOn(ta, "execCommand").mockReturnValue({ stdout: cmd, stderr: "", status: 0 });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      await removeAgent({ agentId: "smoke111" });
      expect(kill).not.toHaveBeenCalled();
    });
  }
});
