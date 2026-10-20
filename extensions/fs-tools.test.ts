/**
 * Guards the deliberate ordering of the fs tool parameters.
 *
 * `description` must stay the first property of edit/write so the model states
 * its intent before emitting the diff or content. TypeBox preserves
 * object-literal insertion order into the emitted schema, so reordering the
 * literals in `extensions/fs-tools.ts` would silently remove that nudge.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { registerFsTools, resetPendingCalls } from "./fs-tools";

interface RegisteredTool {
  name: string;
  parameters: unknown;
}

/** Collect the tools registered against a stubbed ExtensionAPI. */
function registeredTools(): RegisteredTool[] {
  const captured: RegisteredTool[] = [];
  const pi = {
    on: () => undefined,
    registerTool: (definition: RegisteredTool) => captured.push(definition),
    registerCommand: () => undefined,
  };

  registerFsTools(pi as never);
  return captured;
}

/** Property names of a registered tool's schema, in emitted order. */
function emittedPropertyOrder(name: string): string[] {
  const tool = registeredTools().find((definition) => definition.name === name);
  if (!tool) {
    throw new Error(`Tool "${name}" was not registered`);
  }
  // Value.Create omits optional properties, so read the properties map directly.
  return Object.keys(
    (tool.parameters as { properties: Record<string, unknown> }).properties,
  );
}

describe("fs tool parameter ordering", () => {
  it("puts description first for edit", () => {
    expect(emittedPropertyOrder("edit")).toEqual([
      "description",
      "path",
      "oldText",
      "newText",
      "fileHash",
    ]);
  });

  it("puts description first for write", () => {
    expect(emittedPropertyOrder("write")).toEqual([
      "description",
      "path",
      "fileHash",
      "content",
    ]);
  });

  it("registers read with no hash requirement on input", () => {
    const keys = emittedPropertyOrder("read");
    expect(keys[0]).toBe("path");
    expect(keys).not.toContain("fileHash");
  });

  it("registers read, edit, write, and amend once each", () => {
    const names = registeredTools()
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual(["amend", "edit", "read", "write"]);
  });
});

describe("required-parameter validation", () => {
  /** Pull a registered tool's execute function. */
  function executeOf(
    name: string,
  ): (
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<unknown> {
    const tool = registeredTools().find(
      (definition) => definition.name === name,
    );
    if (!tool || typeof (tool as any).execute !== "function") {
      throw new Error(`Tool "${name}" has no execute`);
    }
    return (tool as any).execute;
  }

  it("rejects edit naming every required parameter and each missing one", async () => {
    const error = await executeOf("edit")("t", {
      path: "a.txt",
      oldText: "x",
      newText: "y",
    }).catch((e: Error) => e.message);
    expect(error).toContain("description, path, oldText, newText, fileHash");
    expect(error).toContain("Missing: description, fileHash");
  });

  it("rejects write naming every required parameter and each missing one", async () => {
    const error = await executeOf("write")("t", { content: "x" }).catch(
      (e: Error) => e.message,
    );
    expect(error).toContain("description, path, fileHash, content");
    expect(error).toContain("Missing: description, path, fileHash");
  });

  it("passes edit past requireAll when all parameters are present", async () => {
    // All params present: requireAll must not reject; the failure comes later
    // (stale hash or missing file), not from the parameter check.
    const error = await executeOf("edit")("t", {
      description: "d",
      path: "/nonexistent-fs-tools-test.txt",
      oldText: "x",
      newText: "y",
      fileHash: "abc12345",
    }).catch((e: Error) => e.message);
    expect(error).not.toContain("requires ALL of these parameters");
  });
});

describe("amend", () => {
  beforeEach(() => {
    resetPendingCalls();
  });

  /** Pull a registered tool's execute function. */
  function executeOf(name: string): (...args: unknown[]) => Promise<unknown> {
    const tool = registeredTools().find(
      (definition) => definition.name === name,
    );
    if (!tool || typeof (tool as any).execute !== "function") {
      throw new Error(`Tool "${name}" has no execute`);
    }
    return (tool as any).execute;
  }

  /** A temp workspace with one file, plus its file_hash. */
  function makeWorkspace(): { cwd: string; file: string; hash: string } {
    const cwd = mkdtempSync(join(tmpdir(), "fs-tools-amend-"));
    const file = join(cwd, "a.txt");
    writeFileSync(file, "hello");
    const hash = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex")
      .slice(0, 8);
    return { cwd, file, hash };
  }

  it("rejects when no rejected call is waiting", async () => {
    const { cwd } = makeWorkspace();
    const error = await executeOf("amend")(
      "t",
      { tool: "edit", fields: {} },
      undefined,
      undefined,
      { cwd },
    ).catch((e: Error) => e.message);
    expect(error).toContain("no rejected edit call is waiting");
  });

  it("rejects an unknown tool name", async () => {
    const error = await executeOf("amend")("t", {
      tool: "read",
      fields: {},
    }).catch((e: Error) => e.message);
    expect(error).toContain('tool must be "edit" or "write"');
  });

  it("completes a rejected edit with only the missing fields and executes it", async () => {
    const { cwd, file, hash } = makeWorkspace();
    // Rejected edit: missing description and fileHash.
    const rejectError = await executeOf("edit")(
      "t",
      { path: file, oldText: "hello", newText: "world" },
      undefined,
      undefined,
      { cwd },
    ).catch((e: Error) => e.message);
    expect(rejectError).toContain("Missing: description, fileHash");
    expect(rejectError).toContain('amend(tool="edit"');

    const result = (await executeOf("amend")(
      "t",
      {
        tool: "edit",
        fields: { description: "swap greeting", fileHash: hash },
      },
      undefined,
      undefined,
      { cwd },
    )) as { content: { type: string; text: string }[] };
    const text = result.content
      .map((part) => (part as { text?: string }).text ?? "")
      .join("\n");
    expect(readFileSync(file, "utf-8")).toBe("world");
    expect(text).toMatch(/file_hash: [0-9a-f]{8}/);
  });

  it("keeps the merged partial stored when fields are still missing, then completes", async () => {
    const { cwd, file, hash } = makeWorkspace();
    await executeOf("edit")(
      "t",
      { path: file, oldText: "hello", newText: "world" },
      undefined,
      undefined,
      { cwd },
    ).catch(() => undefined);

    const stillMissing = await executeOf("amend")(
      "t",
      { tool: "edit", fields: { description: "swap greeting" } },
      undefined,
      undefined,
      { cwd },
    ).catch((e: Error) => e.message);
    expect(stillMissing).toContain("still missing fileHash");

    await executeOf("amend")(
      "t",
      { tool: "edit", fields: { fileHash: hash } },
      undefined,
      undefined,
      { cwd },
    );
    expect(readFileSync(file, "utf-8")).toBe("world");
  });

  it("completes a rejected write with only the missing fields", async () => {
    const { cwd, file } = makeWorkspace();
    await executeOf("write")(
      "t",
      { path: join(cwd, "new.txt"), content: "body" },
      undefined,
      undefined,
      { cwd },
    ).catch(() => undefined);
    await executeOf("amend")(
      "t",
      {
        tool: "write",
        fields: { description: "create file", fileHash: "new" },
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(readFileSync(join(cwd, "new.txt"), "utf-8")).toBe("body");
    // The original rejected file is untouched.
    expect(readFileSync(file, "utf-8")).toBe("hello");
  });
});
