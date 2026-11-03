#!/usr/bin/env node
/**
 * `pi-teams`: command-line access to the pi-teams agent network, so a client
 * that is not pi (for example Claude Code) can register as a lead, message
 * agents, and spawn and close workers. Every command except `version` first
 * checks the version file the pi extension writes (see `utils/version.ts`).
 *
 * Output is JSON on stdout, one object per command, except `listen`, which
 * prints one JSON object per line for as long as it runs. Errors go to stderr
 * with a non-zero exit code: 1 for a failed command, 2 when the recipient is
 * unreachable, 3 for a failed version check.
 */
import { parseArgs } from "node:util";
import { getTerminalAdapter } from "./adapters/terminal-registry";
import { formatAgentLine } from "./utils/agentFormat";
import { listVisibleAgents } from "./utils/agentList";
import * as flavoredModels from "./utils/flavoredModels";
import { launchLead, launchWorker } from "./utils/launch";
import {
  authorizeSender,
  broadcastAgentMessage,
  sendAgentMessage,
} from "./utils/messaging";
import { AgentKind, type AgentRecord, type TeamMessage } from "./utils/models";
import {
  adoptOrphanedWorkers,
  ensureRegistryDir,
  generateAgentId,
  readAgentRecord,
  readAgentRecords,
  removeAgentRecord,
  removeStaleSocket,
  writeAgentRecord,
} from "./utils/registry";
import { removeRunState, writeRunState } from "./utils/runstate";
import { setPiBinaryCommand } from "./utils/spawn";
import { removeAgent } from "./utils/teams";
import { RecipientUnreachableError, startListener } from "./utils/transport";
import { checkCliVersion, packageVersion } from "./utils/version";

/** Bump when the message format or a command's JSON output changes incompatibly. */
export const PROTOCOL_VERSION = 1;

const EXIT_FAILED = 1;
const EXIT_UNREACHABLE = 2;
const EXIT_VERSION = 3;
const DEFAULT_CLIENT = "Claude Code";
const PARENT_POLL_MS = 2000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

const USAGE = `Usage: pi-teams <command> [options]

Commands:
  version                          Print the CLI and protocol versions
  listen [--cwd D] [--client N]    Register as a lead and print each inbound message as a JSON line
  list --as ID [--online-only] [--json]
                                   List the agents visible to ID
  send --as ID <recipient> --subject S [--expect-reply] [--summary T] [--body B]
                                   Send a message (body from --body or stdin); recipient: id, worker name, "lead", or "all"
  spawn --as ID --name N --model P/M [--readonly] [--thinking L] [--cwd D] [--window]
                                   Spawn a worker owned by lead ID
  spawn-lead --folder D [--model P/M] [--window] [--as ID]
                                   Spawn an independent peer lead in an existing folder
  close --as ID (<id|name> | --all)
                                   Close one of ID's workers, or all of them
  state --as ID busy|idle          Publish ID's run state for list_agents
  models                           Print the model lists from pi settings
`;

/** A command failure with its exit code. */
class CliError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT_FAILED,
  ) {
    super(message);
    this.name = "CliError";
  }
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Look up the calling agent's record and require that it is a lead. */
function requireLead(id: string | undefined): AgentRecord {
  if (!id) throw new CliError("--as <agent id> is required.");
  const record = readAgentRecord(id);
  if (!record) {
    throw new CliError(`Agent ${id} is not registered. Is its \`pi-teams listen\` process running?`);
  }
  if (record.kind !== AgentKind.Lead) throw new CliError(`Agent ${id} is a worker, not a lead.`);
  return record;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function requireModel(model: string | undefined): string {
  const value = model?.trim();
  if (!value || !value.includes("/")) {
    throw new CliError("--model must be fully qualified as provider/model. Run `pi-teams models` to see the options.");
  }
  return value;
}

// ── commands ─────────────────────────────────────────────────────────────

function cmdVersion(): number {
  const check = checkCliVersion();
  emit({
    version: packageVersion(),
    protocol: PROTOCOL_VERSION,
    versionCheck: check.ok ? { ok: true, extension: check.extension } : { ok: false, message: check.message },
  });
  return 0;
}

/** Register as a lead and stream inbound messages until killed. Never resolves. */
async function cmdListen(args: string[]): Promise<never> {
  const { values } = parseArgs({
    args,
    options: { cwd: { type: "string" }, client: { type: "string" } },
  });
  const id = generateAgentId();
  const record: AgentRecord = {
    id,
    kind: AgentKind.Lead,
    cwd: values.cwd ?? process.cwd(),
    pid: process.pid,
    client: values.client ?? DEFAULT_CLIENT,
    startedAt: Date.now(),
  };
  ensureRegistryDir();
  writeAgentRecord(record);
  const adopted = adoptOrphanedWorkers(record);

  const listener = await startListener(id, (message: TeamMessage) => {
    // Same receiver-side check the pi extension runs: refuse unknown or invisible senders.
    authorizeSender(message, id);
    emit({ type: "message", message });
  });

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await listener.close();
    removeAgentRecord(id);
    removeStaleSocket(id);
    removeRunState(id);
    process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown());
  }
  // The parent (the Claude Code mod) owns this process. When it dies, this
  // process is reparented, so a changed ppid means the owner is gone.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) void shutdown();
  }, PARENT_POLL_MS).unref();

  emit({ type: "ready", id, cwd: record.cwd, pid: process.pid, client: record.client, adopted });
  return await new Promise<never>(() => {});
}

async function cmdList(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      as: { type: "string" },
      "online-only": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const self = requireLead(values.as);
  const ordered = await listVisibleAgents(self, { onlineOnly: values["online-only"] === true });
  const text = ordered.map((entry) => formatAgentLine(entry.record, entry.status, self.id)).join("\n");
  if (!values.json) {
    process.stdout.write(`${text}\n`);
    return 0;
  }
  emit({
    text,
    agents: ordered.map((entry) => ({
      id: entry.record.id,
      kind: entry.record.kind,
      cwd: entry.record.cwd,
      ...(entry.record.name !== undefined ? { name: entry.record.name } : {}),
      ...(entry.record.client !== undefined ? { client: entry.record.client } : {}),
      status: entry.status,
      self: entry.record.id === self.id,
    })),
  });
  return 0;
}

async function cmdSend(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      as: { type: "string" },
      subject: { type: "string" },
      summary: { type: "string" },
      body: { type: "string" },
      "expect-reply": { type: "boolean" },
    },
  });
  const self = requireLead(values.as);
  const recipient = positionals[0];
  if (!recipient) throw new CliError("A recipient is required: an agent id, a worker name, \"lead\", or \"all\".");
  if (!values.subject) throw new CliError("--subject is required.");
  const text = values.body ?? (await readStdin());
  if (!text.trim()) throw new CliError("The message body is empty. Pass --body or pipe it on stdin.");
  const expectReply = values["expect-reply"] === true;
  const records = readAgentRecords();

  if (recipient === "all") {
    const result = await broadcastAgentMessage(self, values.subject, text, expectReply, values.summary, records);
    emit({
      delivered: result.delivered.map((r) => ({ id: r.id, name: r.name })),
      failed: result.failed.map((f) => ({ id: f.record.id, name: f.record.name, reason: f.reason })),
    });
    return 0;
  }
  const target = await sendAgentMessage(self, recipient, values.subject, text, expectReply, values.summary, records);
  emit({ delivered: [{ id: target.id, name: target.name, cwd: target.cwd }], failed: [] });
  return 0;
}

async function cmdSpawn(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      as: { type: "string" },
      name: { type: "string" },
      model: { type: "string" },
      readonly: { type: "boolean" },
      thinking: { type: "string" },
      cwd: { type: "string" },
      window: { type: "boolean" },
    },
  });
  const self = requireLead(values.as);
  if (!values.name) throw new CliError("--name is required.");
  const thinking = values.thinking as (typeof THINKING_LEVELS)[number] | undefined;
  if (thinking !== undefined && !THINKING_LEVELS.includes(thinking)) {
    throw new CliError(`--thinking must be one of ${THINKING_LEVELS.join(", ")}.`);
  }
  const launched = await launchWorker({
    terminal: getTerminalAdapter(),
    leadId: self.id,
    leadCwd: self.cwd,
    model: requireModel(values.model),
    goals: {
      name: values.name,
      cwd: values.cwd,
      thinking,
      separateWindow: values.window,
      readonlyWorker: values.readonly === true,
    },
  });
  emit(launched);
  return 0;
}

async function cmdSpawnLead(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      as: { type: "string" },
      folder: { type: "string" },
      model: { type: "string" },
      window: { type: "boolean" },
    },
  });
  if (values.as) requireLead(values.as);
  if (!values.folder) throw new CliError("--folder is required.");
  const launched = await launchLead({
    terminal: getTerminalAdapter(),
    folder: values.folder,
    model: values.model ? requireModel(values.model) : undefined,
    separateWindow: values.window,
  });
  emit(launched);
  return 0;
}

async function cmdClose(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { as: { type: "string" }, all: { type: "boolean" } },
  });
  const self = requireLead(values.as);
  const records = readAgentRecords();
  const own = records.filter((r) => r.leadId === self.id && r.kind !== AgentKind.Lead);
  const terminal = getTerminalAdapter();

  let targets: AgentRecord[];
  if (values.all) {
    targets = own;
  } else {
    const wanted = positionals[0];
    if (!wanted) throw new CliError("Name a worker (id or name) to close, or pass --all.");
    const target = own.find((r) => r.id === wanted) ?? own.find((r) => r.name === wanted);
    if (!target) {
      const other = records.find((r) => r.id === wanted || r.name === wanted);
      if (other?.kind === AgentKind.Lead) throw new CliError(`Cannot close a peer lead (${other.id}).`);
      if (other) throw new CliError(`Cannot close another lead's worker (${other.id}).`);
      throw new CliError(`Worker ${wanted} not found among your workers.`);
    }
    targets = [target];
  }
  for (const worker of targets) await removeAgent({ agentId: worker.id, terminal });
  emit({ closed: targets.map((w) => ({ id: w.id, name: w.name })) });
  return 0;
}

function cmdState(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { as: { type: "string" } },
  });
  const self = requireLead(values.as);
  const state = positionals[0];
  if (state !== "busy" && state !== "idle") throw new CliError('State must be "busy" or "idle".');
  writeRunState(self.id, state === "busy");
  emit({ id: self.id, state });
  return 0;
}

function cmdModels(): number {
  const flavors = flavoredModels.readFlavoredModels();
  let enabled: string[] = [];
  try {
    enabled = flavoredModels.readEnabledModels();
  } catch {
    // No enabledModels list; the flavors alone are still useful.
  }
  emit({ flavors, enabled });
  return 0;
}

// ── entry ────────────────────────────────────────────────────────────────

/**
 * Run one command.
 *
 * @param argv - Arguments after the executable, command first
 * @returns The process exit code
 */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : EXIT_FAILED;
  }
  try {
    if (command === "version") return cmdVersion();
    const check = checkCliVersion();
    if (!check.ok) throw new CliError(check.message, EXIT_VERSION);
    // The CLI is not pi: workers and leads it spawns launch the `pi` on PATH.
    setPiBinaryCommand("pi");
    switch (command) {
      case "listen":
        return await cmdListen(rest);
      case "list":
        return await cmdList(rest);
      case "send":
        return await cmdSend(rest);
      case "spawn":
        return await cmdSpawn(rest);
      case "spawn-lead":
        return await cmdSpawnLead(rest);
      case "close":
        return await cmdClose(rest);
      case "state":
        return cmdState(rest);
      case "models":
        return cmdModels();
      default:
        throw new CliError(`Unknown command "${command}". Run \`pi-teams help\`.`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`pi-teams: ${message}\n`);
    if (e instanceof CliError) return e.code;
    return e instanceof RecipientUnreachableError ? EXIT_UNREACHABLE : EXIT_FAILED;
  }
}

if (require.main === module) {
  void run(process.argv.slice(2)).then((code) => {
    process.stdout.write("", () => process.exit(code));
  });
}
