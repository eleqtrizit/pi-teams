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

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  timestamp: string;
  /** True once the polling loop has delivered this message to the recipient agent as a user message. */
  delivered: boolean;
  summary?: string;
  color?: string;
}
