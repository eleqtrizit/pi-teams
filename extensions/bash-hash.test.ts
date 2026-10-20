import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBashHash, writtenFiles } from "./bash-hash";

interface RegisteredHandler {
  event: string;
  handler: (event: unknown, ctx: unknown) => Promise<unknown>;
}

function loadHandler(): RegisteredHandler {
  const captured: RegisteredHandler[] = [];
  const pi = {
    on: (event: string, handler: RegisteredHandler["handler"]) =>
      captured.push({ event, handler }),
    registerTool: () => undefined,
    registerCommand: () => undefined,
  };
  registerBashHash(pi as never);
  const handler = captured.find((entry) => entry.event === "tool_result");
  if (!handler) {
    throw new Error("tool_result handler was not registered");
  }
  return handler;
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "bash-hash-"));
}

function hashOf(file: string): string {
  return createHash("sha256")
    .update(readFileSync(file))
    .digest("hex")
    .slice(0, 8);
}

function bashEvent(command: string, cwd: string, text = "done"): unknown {
  return {
    type: "tool_result",
    toolCallId: "t",
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text }],
    isError: false,
  };
}

describe("writtenFiles", () => {
  it("extracts redirect targets and skips /dev/null, globs, and heredoc markers", () => {
    expect(writtenFiles("cat > out.txt <<'EOF'\nhi\nEOF")).toEqual(["out.txt"]);
    expect(writtenFiles("echo hi >> log.txt")).toEqual(["log.txt"]);
    expect(writtenFiles("echo hi | tee copy.txt")).toEqual(["copy.txt"]);
    expect(writtenFiles("grep x f > /dev/null")).toEqual([]);
    expect(writtenFiles("ls > *.txt")).toEqual([]);
    expect(writtenFiles("echo hi 2>err.txt")).toEqual(["err.txt"]);
  });
});

describe("registerBashHash", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends the hash of a file created by a heredoc", async () => {
    const cwd = workspace();
    const file = join(cwd, "README.md");
    writeFileSync(file, "hi\n");
    const { handler } = loadHandler();
    const result = (await handler(
      bashEvent("cat > README.md <<'EOF'\nhi\nEOF\necho done", cwd),
      {
        cwd,
      },
    )) as { content: { type: string; text: string }[] };
    const text = result.content
      .map((part) => (part as { text?: string }).text ?? "")
      .join("\n");
    expect(text).toContain(
      `file_hash: ${hashOf(file)} (bash-written: README.md)`,
    );
  });

  it("appends hashes for absolute paths and keeps the original output", async () => {
    const cwd = workspace();
    const file = join(cwd, "out.log");
    writeFileSync(file, "hi\n");
    const { handler } = loadHandler();
    const result = (await handler(
      bashEvent(`echo hi > ${file}`, cwd, "original output"),
      {
        cwd,
      },
    )) as { content: { type: string; text: string }[] };
    const text = result.content
      .map((part) => (part as { text?: string }).text ?? "")
      .join("\n");
    expect(text).toContain("original output");
    expect(text).toContain(
      `file_hash: ${hashOf(file)} (bash-written: ${file})`,
    );
  });

  it("appends nothing when the command writes no file", async () => {
    const cwd = workspace();
    const { handler } = loadHandler();
    const result = await handler(bashEvent("echo hello", cwd), { cwd });
    expect(result).toEqual({});
  });

  it("appends nothing for errored bash results", async () => {
    const cwd = workspace();
    const { handler } = loadHandler();
    const event = bashEvent("cat > README.md <<'EOF'\nhi\nEOF", cwd);
    (event as { isError: boolean }).isError = true;
    const result = await handler(event, { cwd });
    expect(result).toEqual({});
  });
});
