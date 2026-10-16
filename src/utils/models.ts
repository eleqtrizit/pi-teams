/**
 * Agent identity type, matching the `PI_AGENT_TYPE` values that
 * `extensions/index.ts` derives `isLead` and `isWorker` from.
 */
export enum AgentKind {
  Lead = "lead",
  Teammate = "teammate",
  ReadonlyWorker = "readonly-worker",
}

/** Online/offline state of a registered agent. */
export enum AgentStatus {
  Online = "Online",
  Offline = "Offline",
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
  /** Epoch milliseconds at registration. */
  startedAt: number;
}

export interface Member {
  agentId: string;
  /** Registry identifier assigned to this agent process. */
  registryId?: string;
  name: string;
  agentType: string;
  model?: string;
  joinedAt: number;
  tmuxPaneId: string;
  windowId?: string;
  cwd: string;
  subscriptions: any[];
  color?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  backendType?: string;
  isActive?: boolean;
}

export interface TeamConfig {
  name: string;
  description: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string;
  members: Member[];
  defaultModel?: string;
  separateWindows?: boolean;
}

/**
 * A message sent between team members over the socket transport.
 *
 * The recipient gets the message immediately and keeps no copy on disk.
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
