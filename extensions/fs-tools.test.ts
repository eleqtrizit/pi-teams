/**
 * Guards the deliberate ordering of the fs tool parameters.
 *
 * `description` must stay the first property of edit/write so the model states
 * its intent before emitting the diff or content. TypeBox preserves
 * object-literal insertion order into the emitted schema, so reordering the
 * literals in `extensions/fs-tools.ts` would silently remove that nudge.
 */

import { Value } from "typebox/value";
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
  return Object.keys(Value.Create(tool.parameters as never) as Record<string, unknown>);
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
    const names = registeredTools().map((tool) => tool.name).sort();
    expect(names).toEqual(["edit", "read", "write"]);
  });
});
