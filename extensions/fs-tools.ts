import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
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
 * does not exist yet. `description` and `readHash` are validated inside `execute`
 * (not by the JSON schema) so a rejected call names every required parameter and
 * which ones are missing, instead of pi core's schema error naming only one. The
 * rejected partial is stored, and the `amend` tool completes it with just the
 * missing fields instead of a full resend.
 */

const ReadParams = Type.Object({
  path: Type.String({
    description: "Path to the file to read (relative or absolute)",
  }),
  offset: Type.Optional(
    Type.Number({
      description: "Line number to start reading from (1-indexed)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of lines to read" }),
  ),
});

const EditParams = Type.Object({
  description: Type.Optional(
    Type.String({
      description:
        "Why this edit is needed, in plain English: what changes, what it fixes or enables, and name the " +
        "functions/classes/imports/top-level symbols touched. Fill this in FIRST, before path and the diff.",
    }),
  ),
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
  readHash: Type.Optional(
    Type.String({
      description:
        "The content_hash value printed by the read tool (or by the edit/write that produced the current " +
        'file). It must match the file\'s current on-disk content or the edit is rejected. Pass "new" when ' +
        "the file does not exist yet. Read the file first if you do not have this hash.",
    }),
  ),
});

const WriteParams = Type.Object({
  description: Type.Optional(
    Type.String({
      description:
        "Why this file is being written, in plain English: what it contains and what it is for. " +
        "Fill this in FIRST, before path.",
    }),
  ),
  path: Type.String({
    description:
      "Path to the file to write (relative or absolute). Parent directories are created. " +
      "Second parameter, after description.",
  }),
  readHash: Type.Optional(
    Type.String({
      description:
        "The content_hash value printed by the read tool when you last read this file. It must match the " +
        'file\'s current on-disk content or the write is rejected. Pass "new" when the file does not exist ' +
        "yet. Read the file first if you do not have this hash. Third parameter, after path.",
    }),
  ),
  content: Type.String({
    description:
      "Full content to write. This replaces the file entirely — for a partial change to an existing file, " +
      "use edit instead. Fill this LAST, after description, path and readHash, so a missing small field " +
      "is caught before generating the content.",
  }),
});

/** Required edit parameters, in fill order. */
const EDIT_REQUIRED = [
  "description",
  "path",
  "oldText",
  "newText",
  "readHash",
] as const;
/** Required write parameters, in fill order. */
const WRITE_REQUIRED = ["description", "path", "readHash", "content"] as const;

/** Tools whose rejected partial calls `amend` can complete. */
type AmendableTool = "edit" | "write";

/** Last rejected partial call per tool, kept so `amend` can complete it. */
const pendingCalls = new Map<AmendableTool, Record<string, unknown>>();

/** Clear stored rejected partials. Test isolation only. */
export function resetPendingCalls(): void {
  pendingCalls.clear();
}

/**
 * Reject the call unless every required parameter is present, naming the full
 * list each time so the caller never fixes one parameter only to hit the next.
 *
 * The rejected partial is stored for `amend`, which can complete the call with
 * only the missing fields instead of a full resend.
 */
function requireAll(
  tool: AmendableTool,
  params: any,
  required: readonly string[],
): void {
  const missing = required.filter((key) => params?.[key] === undefined);
  if (missing.length === 0) {
    return;
  }
  pendingCalls.set(tool, { ...params });
  throw new Error(
    `Rejected: ${tool} requires ALL of these parameters: ${required.join(", ")}. ` +
      `Missing: ${missing.join(", ")}. ` +
      `Resend the full call, or call amend(tool="${tool}", fields={...}) with just the ` +
      `missing parameters: ${missing.join(", ")}.`,
  );
}

/** First 8 hex characters of the sha256 digest of the file bytes. */
function contentHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Append the file's fresh content hash to a tool result's text output.
 *
 * Images keep their original rendering; only text results are rewritten.
 */
function withFreshHash(
  result: AgentToolResult<any>,
  bytes: Buffer,
): AgentToolResult<any> {
  const hashLine = `content_hash: ${contentHash(bytes)}`;
  const text = result.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
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

/**
 * Run an edit against the built-in edit tool and append the fresh hash.
 *
 * Shared by the `edit` tool and `amend`, which completes a rejected edit call.
 */
async function runEdit(
  toolCallId: string,
  params: any,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<any>> {
  await assertFresh(params.path, params.readHash);

  const builtinEdit = createEditTool(ctx.cwd);
  const input: EditToolInput = {
    path: params.path,
    edits: [{ oldText: params.oldText, newText: params.newText }],
  };
  const result = await builtinEdit.execute(toolCallId, input, signal, onUpdate);
  await withFreshHash(result, await readFile(params.path));
  return result;
}

/**
 * Run a write against the built-in write tool and append the fresh hash.
 *
 * Shared by the `write` tool and `amend`, which completes a rejected write call.
 */
async function runWrite(
  toolCallId: string,
  params: any,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<any>> {
  await assertFresh(params.path, params.readHash);

  const builtinWrite = createWriteTool(ctx.cwd);
  const input: WriteToolInput = {
    path: params.path,
    content: params.content,
  };
  const result = await builtinWrite.execute(
    toolCallId,
    input,
    signal,
    onUpdate,
  );
  await withFreshHash(result, await readFile(params.path));
  return result;
}

const AmendParams = Type.Object({
  tool: Type.String({
    description: 'The rejected call to complete: "edit" or "write".',
  }),
  fields: Type.Record(Type.String(), Type.String(), {
    description:
      "The missing parameters and their values, keyed by parameter name. Fields already " +
      "supplied in the rejected call stay as they were unless overridden here.",
  }),
});

function asAnySchema<T>(schema: T): any {
  return schema;
}

/**
 * Complete a rejected `edit` or `write` call from its stored partial.
 *
 * Merges the supplied fields over the rejected call's parameters, re-checks
 * the full required list, and executes the completed call. A merge that still
 * leaves fields missing keeps the merged partial stored, so a follow-up amend
 * can continue.
 */
async function runAmend(
  toolCallId: string,
  params: any,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<any>> {
  const tool = params?.tool;
  if (tool !== "edit" && tool !== "write") {
    throw new Error('amend: tool must be "edit" or "write".');
  }
  const pending = pendingCalls.get(tool);
  if (!pending) {
    throw new Error(
      `amend: no rejected ${tool} call is waiting. Send a normal ${tool} call first; ` +
        "amend only completes a call that was rejected for missing parameters.",
    );
  }
  const merged = { ...pending, ...params.fields };
  pendingCalls.set(tool, merged);
  const required = tool === "edit" ? EDIT_REQUIRED : WRITE_REQUIRED;
  const missing = required.filter((key) => merged[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `amend: ${tool} is still missing ${missing.join(", ")}. ` +
        "Call amend again with those fields.",
    );
  }
  pendingCalls.delete(tool);
  return tool === "edit"
    ? runEdit(toolCallId, merged, signal, onUpdate, ctx)
    : runWrite(toolCallId, merged, signal, onUpdate, ctx);
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
    async execute(
      toolCallId,
      params: any,
      signal,
      onUpdate,
      ctx: ExtensionContext,
    ) {
      const builtinRead = createReadTool(ctx.cwd);
      const result = await builtinRead.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );

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
      "original file. ALL parameters are required (description, path, oldText, newText, readHash) even " +
      "though the schema may show some as optional. Fill in order: description, path, then oldText, " +
      "newText and readHash. Make a separate edit call for each change.",
    promptSnippet:
      "Make precise file edits with exact text replacement, one targeted replacement per call",
    promptGuidelines: [
      "Use edit for precise changes to an existing file; edit's oldText must match exactly one unique region, " +
        "kept as small as possible and never padded with unchanged context.",
      "Use edit with one oldText/newText pair per call; make a separate edit call for each additional change.",
      "When calling edit, fill parameters in this order: description, path, then oldText, newText and readHash. " +
        "State the reason for the change before producing the diff.",
      "edit's readHash must be the content_hash from your last read of that file; the result carries the file's fresh hash for follow-up edits.",
    ],
    parameters: asAnySchema(EditParams),
    async execute(
      toolCallId,
      params: any,
      signal,
      onUpdate,
      ctx: ExtensionContext,
    ) {
      requireAll("edit", params, EDIT_REQUIRED);
      return runEdit(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    name: "write",
    label: "Write",
    description:
      "Write a file's complete content, replacing whatever was there. Creates the file and any parent " +
      "directories. ALL parameters are required (description, path, readHash, content) even though the " +
      "schema may show some as optional. Fill in order: description, path, then readHash and content. " +
      "Use write only for new files or complete rewrites — for a partial change to an existing file, use edit.",
    promptSnippet: "Create or overwrite a file with its complete content",
    promptGuidelines: [
      "Use write only for new files or complete rewrites; use edit for partial changes to an existing file.",
      "When calling write, fill parameters in this order: description, path, then readHash and content. " +
        "State the reason for the file before generating its content.",
      'write\'s readHash must be the content_hash from your last read of that file; pass "new" only if the file does not exist yet.',
    ],
    parameters: asAnySchema(WriteParams),
    async execute(
      toolCallId,
      params: any,
      signal,
      onUpdate,
      ctx: ExtensionContext,
    ) {
      requireAll("write", params, WRITE_REQUIRED);
      return runWrite(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    name: "amend",
    label: "Amend",
    description:
      "Complete a rejected edit or write call without resending the whole call. Use it only after edit " +
      'or write was rejected for missing parameters: pass tool ("edit" or "write") and fields with ' +
      "just the missing parameters. The rejected call's other parameters are reused as-is, and the " +
      "completed call runs immediately. If fields are still missing, call amend again with those.",
    promptSnippet:
      "Complete a rejected edit or write call with just the missing parameters",
    promptGuidelines: [
      'After edit or write is rejected for missing parameters, call amend(tool="<tool>", fields={...}) ' +
        "with only the missing parameters instead of resending the full call.",
      "Never use amend for a call that was not rejected; send a normal edit or write call instead.",
    ],
    parameters: asAnySchema(AmendParams),
    async execute(
      toolCallId,
      params: any,
      signal,
      onUpdate,
      ctx: ExtensionContext,
    ) {
      return runAmend(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
