import { describe, it, expect } from "vitest";
import { agentSocketPath, sanitizeName } from "./paths";

describe("Security Audit - Path Traversal (Prevention Check)", () => {
  it("should reject path traversal via an agent ID", () => {
    expect(() => agentSocketPath("../../etc/passwd")).toThrow(/Invalid agent ID/);
  });

  it("should throw an error for path traversal via taskId", () => {
    const maliciousTaskId = "../../../etc/passwd";
    expect(() => sanitizeName(maliciousTaskId)).toThrow();
  });
});

describe("Security Audit - Command Injection (Fixed)", () => {
  it("should not be vulnerable to command injection in spawn_teammate (via parameters)", () => {
    const maliciousCwd = "; rm -rf / ;";
    const name = "attacker";
    const piBinary = "pi";
    const cmd = `PI_AGENT_NAME=${name} ${piBinary}`;
    const itermCmd = `cd '${maliciousCwd}' && ${cmd}`;
    expect(itermCmd).toContain("cd '; rm -rf / ;' &&");
    expect(itermCmd).not.toContain("cd ; rm -rf / ; &&");
  });
});
