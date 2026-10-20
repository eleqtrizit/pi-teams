/**
 * Guards the deliberate ordering of the fs tool parameters.
 *
 * `description` must stay the first property of edit/write so the model states
 * its intent before emitting the diff or content. TypeBox preserves
 * object-literal insertion order into the emitted schema, so reordering the
 * literals in `extensions/fs-tools.ts` would silently remove that nudge.
 */

import { describe, expect, it } from "vitest";
import { registerFsTools } from "./fs-tools";

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
      "readHash",
    ]);
  });

  it("puts description first for write", () => {
    expect(emittedPropertyOrder("write")).toEqual([
      "description",
      "path",
      "content",
      "readHash",
    ]);
  });

  it("registers read with no hash requirement on input", () => {
    const keys = emittedPropertyOrder("read");
    expect(keys[0]).toBe("path");
    expect(keys).not.toContain("readHash");
  });

  it("registers read, edit, and write once each", () => {
    const names = registeredTools()
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual(["edit", "read", "write"]);
  });
});

describe("required-parameter validation", () => {
  /** Pull a registered tool's execute function. */
  function executeOf(
    name: string,
  ): (id: string, params: unknown) => Promise<unknown> {
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
    expect(error).toContain("description, path, oldText, newText, readHash");
    expect(error).toContain("Missing: description, readHash");
  });

  it("rejects write naming every required parameter and each missing one", async () => {
    const error = await executeOf("write")("t", { content: "x" }).catch(
      (e: Error) => e.message,
    );
    expect(error).toContain("description, path, content, readHash");
    expect(error).toContain("Missing: description, path, readHash");
  });

  it("passes edit past requireAll when all parameters are present", async () => {
    // All params present: requireAll must not reject; the failure comes later
    // (stale hash or missing file), not from the parameter check.
    const error = await executeOf("edit")("t", {
      description: "d",
      path: "/nonexistent-fs-tools-test.txt",
      oldText: "x",
      newText: "y",
      readHash: "abc12345",
    }).catch((e: Error) => e.message);
    expect(error).not.toContain("requires ALL of these parameters");
  });
});
