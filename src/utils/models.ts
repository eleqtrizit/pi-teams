/**
 * Agent identity type, matching the `PI_AGENT_TYPE` values that
 * `extensions/index.ts` derives `isLead` and `isWorker` from.
 */
export enum AgentKind {
  Lead = "lead",
  Teammate = "teammate",
  ReadonlyWorker = "readonly-worker",
}

/** Available/offline/busy state of a registered agent. */
export enum AgentStatus {
  Available = "Available",
  Offline = "Offline",
  Busy = "Busy",
}

/**
 * A registered agent in the per-user tmp-dir registry.
 *
 * Every pi session that loads the pi-teams extension registers itself; one-shot
 * `pi -p` sessions that were not spawned by pi-teams do not register.
 */
export interface AgentRecord {
  /** 8-character `[a-z0-9]` identifier. */
  id: string;
  kind: AgentKind;
  /** Absolute working directory. */
  cwd: string;
  pid: number;
  /** Set for Teammate and ReadonlyWorker records only. */
  leadId?: string;
  /** Worker display name, e.g. "alice". */
  name?: string;
  model?: string;
  /** Terminal pane id, stored at spawn time so removal needs no config. */
  paneId?: string;
  /** Terminal window id, stored at spawn time so removal needs no config. */
  windowId?: string;
  /** Epoch milliseconds at registration. */
  startedAt: number;
}

/**
 * A message sent between registered agents over the socket transport.
 *
 * The recipient receives the message immediately and keeps no copy on disk.
 */
export interface TeamMessage {
  /** Short unique identifier of the message. */
  id: string;
  /** Identifier of the sending agent. */
  from: string;
  /** Identifier of the receiving agent. */
  to: string;
  /** Human-readable sender label, such as "Worker alice in /path". */
  fromLabel: string;
  subject: string;
  text: string;
  /** ISO 8601 time the sender created the message. */
  timestamp: string;
  summary?: string;
}
