import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createEditTool,
  type EditToolInput,
  createReadTool,
  createWriteTool,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Hash-guarded `read`, `edit`, and `write` tool overrides.
 *
 * Stale-write guard: every text `read` result ends with a `content_hash: xxxxxxxx`
 * line (first 8 hex chars of sha256 of the file bytes). `edit` and `write` take a
 * required `readHash` parameter that must still match the file's on-disk content,
 * or the call is rejected so the agent cannot mutate a file it saw an older
 * version of. A successful `edit` or `write` appends the file's fresh hash to its
 * result, so follow-up edits need no extra read. Pass `"new"` for a file that
 * does not exist yet.
 */

const ReadParams = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const EditParams = Type.Object({
  description: Type.String({
    description:
      "Why this edit is needed, in plain English: what changes, what it fixes or enables, and name the " +
      "functions/classes/imports/top-level symbols touched. Fill this in FIRST, before path and the diff.",
  }),
  path: Type.String({
    description:
      "Path to the single file to edit (relative or absolute). Second parameter, after description.",
  }),
  oldText: Type.String({
    description:
      "Exact text to replace. Must match one unique region of the original file byte-for-byte, including " +
      "whitespace. Keep it as small as possible while still unique; do not pad it with large unchanged regions.",
  }),
  newText: Type.String({ description: "Replacement text for that region." }),
  readHash: Type.String({
    description:
      "The content_hash value printed by the read tool (or by the edit/write that produced the current " +
      'file). It must match the file\'s current on-disk content or the edit is rejected. Pass "new" when ' +
      "the file does not exist yet. Read the file first if you do not have this hash.",
  }),
});

const WriteParams = Type.Object({
  description: Type.String({
    description:
      "Why this file is being written, in plain English: what it contains and what it is for. " +
      "Fill this in FIRST, before path and content.",
  }),
  path: Type.String({
    description:
      "Path to the file to write (relative or absolute). Parent directories are created. " +
      "Second parameter, after description.",
  }),
  content: Type.String({
    description:
      "Full content to write. This replaces the file entirely — for a partial change to an existing file, " +
      "use edit instead.",
  }),
  readHash: Type.String({
    description:
      "The content_hash value printed by the read tool when you last read this file. It must match the " +
      'file\'s current on-disk content or the write is rejected. Pass "new" when the file does not exist ' +
      "yet. Read the file first if you do not have this hash.",
  }),
});

/** First 8 hex characters of the sha256 digest of the file bytes. */
function contentHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Append the file's fresh content hash to a tool result's text output.
 *
 * Images keep their original rendering; only text results are rewritten.
 */
function withFreshHash(result: AgentToolResult<any>, bytes: Buffer): AgentToolResult<any> {
  const hashLine = `content_hash: ${contentHash(bytes)}`;
  const text = result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  result.content = [{ type: "text", text: `${text}\n${hashLine}` }];
  return result;
}

/**
 * Verify the caller holds the file's current hash, or throw.
 *
 * A missing file is accepted: any hash is valid for a file that does not exist yet.
 */
async function assertFresh(path: string, readHash: string): Promise<void> {
  let currentHash: string | null = null;
  try {
    currentHash = contentHash(await readFile(path));
  } catch {
    return;
  }
  if (readHash !== currentHash) {
    throw new Error(
      `Rejected: ${path} changed since it was last read ` +
        `(expected content_hash ${readHash}, current is ${currentHash}). ` +
        "Read the file again, then retry with the fresh hash.",
    );
  }
}

function asAnySchema<T>(schema: T): any {
  return schema;
}

export function registerFsTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "Read",
    description:
      "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are " +
      "sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit " +
      "first). Use offset/limit for large files. When you need the full file, continue with offset until " +
      "complete. Text results end with a `content_hash: xxxxxxxx` line — pass that hash to edit or write.",
    promptSnippet: "Read file contents",
    promptGuidelines: [
      "Use read to examine files instead of cat or sed.",
      "Each text read ends with a `content_hash:` line; edit and write require that hash for existing files.",
    ],
    parameters: asAnySchema(ReadParams),
    async execute(toolCallId, params: any, signal, onUpdate, ctx: ExtensionContext) {
      const builtinRead = createReadTool(ctx.cwd);
      const result = await builtinRead.execute(toolCallId, params, signal, onUpdate);

      // Hash the file as it exists on disk right now, regardless of any
      // offset/limit truncation in the output. Images keep their rendering.
      const isText = result.content.some((part) => part.type === "text");
      if (isText) {
        withFreshHash(result, await readFile(params.path));
      }
      return result;
    },
  });

  pi.registerTool({
    name: "edit",
    label: "Edit",
    description:
      "Edit one file with exactly one targeted replacement. `oldText` must match a unique region of the " +
      "original file. Fill parameters in order: description, path, then oldText, newText and readHash. " +
      "Make a separate edit call for each change.",
    promptSnippet: "Make precise file edits with exact text replacement, one targeted replacement per call",
    promptGuidelines: [
      "Use edit for precise changes to an existing file; edit's oldText must match exactly one unique region, " +
      "kept as small as possible and never padded with unchanged context.",
      "Use edit with one oldText/newText pair per call; make a separate edit call for each additional change.",
      "When calling edit, fill parameters in this order: description, path, then oldText, newText and readHash. " +
      "State the reason for the change before producing the diff.",
      "edit's readHash must be the content_hash from your last read of that file; the result carries the file's fresh hash for follow-up edits.",
    ],
    parameters: asAnySchema(EditParams),
    async execute(toolCallId, params: any, signal, onUpdate, ctx: ExtensionContext) {
      await assertFresh(params.path, params.readHash);

      const builtinEdit = createEditTool(ctx.cwd);
      const input: EditToolInput = {
        path: params.path,
        edits: [{ oldText: params.oldText, newText: params.newText }],
      };
      const result = await builtinEdit.execute(toolCallId, input, signal, onUpdate);
      await withFreshHash(result, await readFile(params.path));
      return result;
    },
  });

  pi.registerTool({
    name: "write",
    label: "Write",
    description:
      "Write a file's complete content, replacing whatever was there. Creates the file and any parent " +
      "directories. Fill parameters in order: description, path, then content and readHash. Use write only " +
      "for new files or complete rewrites — for a partial change to an existing file, use edit.",
    promptSnippet: "Create or overwrite a file with its complete content",
    promptGuidelines: [
      "Use write only for new files or complete rewrites; use edit for partial changes to an existing file.",
      "When calling write, fill parameters in this order: description, path, then content and readHash. " +
      "State the reason for the file before generating its content.",
      'write\'s readHash must be the content_hash from your last read of that file; pass "new" only if the file does not exist yet.',
    ],
    parameters: asAnySchema(WriteParams),
    async execute(toolCallId, params: any, signal, onUpdate, ctx: ExtensionContext) {
      await assertFresh(params.path, params.readHash);

      const builtinWrite = createWriteTool(ctx.cwd);
      const input: WriteToolInput = { path: params.path, content: params.content };
      const result = await builtinWrite.execute(toolCallId, input, signal, onUpdate);
      await withFreshHash(result, await readFile(params.path));
      return result;
    },
  });
}
