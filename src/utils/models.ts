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
  read: boolean;
  summary?: string;
  color?: string;
}
