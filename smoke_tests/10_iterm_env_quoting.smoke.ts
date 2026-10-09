// CLAIM S10: iTerm2 shellCommand emits KEY=value unquoted, so a PI_* value with spaces or shell
// metacharacters (for example a session path in a directory with a space) splits or is interpreted by the shell.
import { describe, expect, it, vi, afterEach } from "vitest";
import { Iterm2Adapter } from "../src/adapters/iterm2-adapter";

describe("S10 iTerm2 env quoting", () => {
  afterEach(() => vi.restoreAllMocks());
  it("quotes PI_* env values in the generated script", () => {
    const adapter = new Iterm2Adapter();
    let script = "";
    vi.spyOn(adapter as any, "runAppleScript").mockImplementation((s: string) => {
      script = s;
      return { stdout: "sid", stderr: "", status: 0 };
    });
    adapter.spawn({ name: "w", cwd: "/tmp", command: "pi", env: { PI_SESSION_FILE: "/Users/a b/s;touch x.jsonl" } });
    console.log(script.split("\n").find((l) => l.includes("write text")));
    expect(script).toContain("PI_SESSION_FILE='/Users/a b/s;touch x.jsonl'");
  });
});
