export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export interface OpenFile {
  path: string;
  content: string;
  language: string;
  dirty?: boolean;
}

export interface AgentMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  toolName?: string;
  toolId?: string;
  isStreaming?: boolean;
}

export interface AgentSession {
  id: string;
  name: string;
  status: "running" | "thinking" | "error" | "idle" | "stopped";
  task: string;
  cwd: string;
  messages: AgentMessage[];
  sessionId?: string; // claude CLI session ID for resume
  model?: string;
  costUsd?: number;
  createdAt: number;
}

export interface TerminalTab {
  id: string;
  name: string;
}

export type PanelView = "explorer" | "agents" | "search";
export type BottomPanelView = "terminal" | "output" | "agent-detail";
