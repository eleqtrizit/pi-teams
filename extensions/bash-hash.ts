import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type {
  ExtensionAPI,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

/**
 * Hash lines for bash-written files.
 *
 * The `## New Files` guidance asks agents to create files with the write tool,
 * but a bash heredoc or redirect still happens. A file created that way has no
 * `content_hash` line in any tool result, so the stale-write guard has nothing
 * for the agent to pass to `edit` or `write`. This handler detects files a bash
 * command wrote (output redirection and `tee`) and appends their hash to the
 * tool result, restoring the guard's contract.
 */

/** First 8 hex characters of the sha256 digest of the file bytes. */
function contentHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Extract files a shell command writes.
 *
 * Matches output redirections (`>`, `>>`, `&>`, `2>`) and `tee`, skipping
 * `/dev/null`, globs, options, and heredoc markers. The path is matched
 * permissively, then verified against the filesystem before hashing, so a
 * false-positive match costs nothing.
 */
export function writtenFiles(command: string): string[] {
  const matches: string[] = [];
  const redirect =
    /(?<![<>])>{1,2}(?!&)\s*"([^"]+)"|(?<![<>])>{1,2}(?!&)\s*'([^']+)'|(?<![<>])>{1,2}(?!&)\s*([^\s<>|;&"']+)/g;
  const tee =
    /\btee\s+(?:-[a-zA-Z]+\s+)*"([^"]+)"|\btee\s+(?:-[a-zA-Z]+\s+)*'([^']+)'|\btee\s+(?:-[a-zA-Z]+\s+)*([^\s<>|;&"']+)/g;
  for (const regex of [redirect, tee]) {
    for (const match of command.matchAll(regex)) {
      const path = (match[1] ?? match[2] ?? match[3])?.trim();
      if (
        path &&
        path !== "/dev/null" &&
        !/[*?]/.test(path) &&
        !path.startsWith("-")
      ) {
        matches.push(path);
      }
    }
  }
  return [...new Set(matches)];
}

/**
 * Append `content_hash:` lines for files the bash command wrote.
 *
 * Every match is verified against the filesystem before it is hashed, so the
 * regex's permissiveness cannot fabricate a hash. Relative paths resolve
 * against the session's cwd.
 */
export function registerBashHash(pi: ExtensionAPI): void {
  if (typeof pi.on !== "function") {
    return;
  }
  pi.on(
    "tool_result",
    async (event: ToolResultEvent, ctx): Promise<ToolResultEventResult> => {
      if (event.toolName !== "bash" || event.isError) {
        return {};
      }
      const command =
        typeof event.input.command === "string" ? event.input.command : "";
      if (!command) {
        return {};
      }
      const lines: string[] = [];
      for (const path of writtenFiles(command)) {
        const absolute = isAbsolute(path) ? path : join(ctx.cwd, path);
        try {
          const hash = contentHash(await readFile(absolute));
          lines.push(`content_hash: ${hash} (bash-written: ${path})`);
        } catch {
          // Redirect matched but the file does not exist (for example a failed
          // write); nothing to hash.
        }
      }
      if (lines.length === 0) {
        return {};
      }
      const text = event.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("\n");
      return {
        content: [{ type: "text", text: `${text}\n${lines.join("\n")}` }],
      };
    },
  );
}
