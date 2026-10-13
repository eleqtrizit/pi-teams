export interface Member {
  agentId: string;
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
  /** Name of the sending agent. */
  from: string;
  /** Name of the receiving agent. */
  to: string;
  subject: string;
  text: string;
  /** ISO 8601 time the sender created the message. */
  timestamp: string;
  summary?: string;
}
