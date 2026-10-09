// CLAIM S11: the Orca adapter joins PI_* values into a shell string without quoting.
import { describe, expect, it, vi, afterEach } from "vitest";
import * as ta from "../src/utils/terminal-adapter";
import { OrcaAdapter } from "../src/adapters/orca-adapter";

describe("S11 Orca env quoting", () => {
  afterEach(() => vi.restoreAllMocks());
  it("quotes PI_* env values in --command", () => {
    const spy = vi.spyOn(ta, "execCommand").mockReturnValue({ stdout: JSON.stringify({ ok: true, result: { terminal: { handle: "h" } } }), stderr: "", status: 0 });
    new OrcaAdapter().spawn({ name: "w", cwd: "/tmp", command: "pi", env: { PI_SESSION_FILE: "/a b/s;touch x" } });
    const args = spy.mock.calls[0][1] as string[];
    const cmd = args[args.indexOf("--command") + 1];
    console.log(cmd);
    expect(cmd).toContain("PI_SESSION_FILE='/a b/s;touch x'");
  });
});
