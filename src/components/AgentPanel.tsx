import React, { useState, useRef, useEffect } from "react";
import type { AgentSession, AgentMessage } from "../types/index.ts";

interface AgentPanelProps {
  agents: AgentSession[];
  onNewAgent: () => void;
  onStopAgent: (id: string) => void;
  onDeleteAgent: (id: string) => void;
  onSendMessage: (id: string, message: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: "#3fb950", thinking: "#d29922", error: "#ff7b72", idle: "#8b949e", stopped: "#484f58",
};

const STATUS_LABELS: Record<string, string> = {
  running: "Running", thinking: "Thinking...", error: "Error", idle: "Idle", stopped: "Stopped",
};

const TOOL_ICONS: Record<string, string> = {
  Bash: "$_", Read: "R", Write: "W", Edit: "E", Grep: "G", Glob: "F",
  WebSearch: "W", WebFetch: "W", Agent: "A",
};

function ToolCallMessage({ msg }: { msg: AgentMessage }) {
  const [expanded, setExpanded] = useState(false);
  const icon = TOOL_ICONS[msg.toolName || ""] || "T";
  const preview = msg.content.split("\n")[0].slice(0, 80);

  return (
    <div style={{
      background: "#161b22", border: "1px solid #21262d", borderRadius: 6,
      marginBottom: 4, overflow: "hidden",
    }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
          cursor: "pointer", fontSize: 12,
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{
          background: "#21262d", color: "#58a6ff", borderRadius: 3, padding: "1px 5px",
          fontSize: 10, fontWeight: 700, fontFamily: "monospace",
        }}>{icon}</span>
        <span style={{ color: "#58a6ff", fontWeight: 600 }}>{msg.toolName}</span>
        <span style={{ color: "#484f58", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {preview}
        </span>
        <span style={{ color: "#484f58", fontSize: 10 }}>{expanded ? "▼" : "▶"}</span>
      </div>
      {expanded && (
        <pre style={{
          padding: "8px 10px", margin: 0, fontSize: 11, color: "#8b949e",
          background: "#0d1117", borderTop: "1px solid #21262d",
          overflow: "auto", maxHeight: 200, whiteSpace: "pre-wrap", wordBreak: "break-all",
        }}>
          {msg.content}
        </pre>
      )}
    </div>
  );
}

function ToolResultMessage({ msg }: { msg: AgentMessage }) {
  const [expanded, setExpanded] = useState(false);
  const lines = msg.content.split("\n");
  const preview = lines[0].slice(0, 100);
  const isLong = msg.content.length > 200;

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          fontSize: 11, color: "#484f58", cursor: isLong ? "pointer" : "default",
          padding: "2px 10px",
        }}
        onClick={() => isLong && setExpanded(!expanded)}
      >
        {isLong && !expanded ? (
          <span>{preview}... <span style={{ color: "#58a6ff" }}>({lines.length} lines)</span></span>
        ) : null}
      </div>
      {(!isLong || expanded) && (
        <pre style={{
          padding: "4px 10px", margin: 0, fontSize: 11, color: "#6e7681",
          overflow: "auto", maxHeight: 150, whiteSpace: "pre-wrap", wordBreak: "break-all",
        }}>
          {msg.content}
        </pre>
      )}
    </div>
  );
}

function AssistantMessage({ msg }: { msg: AgentMessage }) {
  return (
    <div style={{
      padding: "8px 12px", marginBottom: 4, fontSize: 13, color: "#e6edf3",
      lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
    }}>
      {msg.content}
      {msg.isStreaming && (
        <span style={{ color: "#58a6ff", animation: "blink 1s infinite" }}>▊</span>
      )}
    </div>
  );
}

function UserMessage({ msg }: { msg: AgentMessage }) {
  return (
    <div style={{
      padding: "8px 12px", marginBottom: 4, fontSize: 13,
      color: "#e6edf3", background: "#161b22", borderRadius: 6,
      border: "1px solid #21262d",
    }}>
      <span style={{ color: "#8b949e", fontSize: 11, fontWeight: 600, marginRight: 8 }}>YOU</span>
      {msg.content}
    </div>
  );
}

function SystemMessage({ msg }: { msg: AgentMessage }) {
  return (
    <div style={{
      padding: "4px 12px", marginBottom: 2, fontSize: 11, color: "#6e7681",
      fontStyle: "italic",
    }}>
      {msg.content}
    </div>
  );
}

function MessageList({ messages }: { messages: AgentMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.content.length]);

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
      {messages.map((msg, i) => {
        if (msg.role === "tool") return <ToolCallMessage key={i} msg={msg} />;
        if (msg.role === "system" && msg.toolId) return <ToolResultMessage key={i} msg={msg} />;
        if (msg.role === "system") return <SystemMessage key={i} msg={msg} />;
        if (msg.role === "user") return <UserMessage key={i} msg={msg} />;
        return <AssistantMessage key={i} msg={msg} />;
      })}
      <div ref={endRef} />
    </div>
  );
}

function AgentDetail({
  agent, onStop, onDelete, onSendMessage, onBack,
}: {
  agent: AgentSession;
  onStop: () => void;
  onDelete: () => void;
  onSendMessage: (msg: string) => void;
  onBack: () => void;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isActive = agent.status === "running" || agent.status === "thinking";
  const canMessage = agent.status === "idle" && agent.sessionId;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#0d1117" }}>
      {/* Header */}
      <div style={{
        padding: "8px 12px", borderBottom: "1px solid #21262d",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <button
          onClick={onBack}
          style={{
            background: "none", border: "none", color: "#8b949e", cursor: "pointer",
            fontSize: 14, padding: "2px 4px",
          }}
        >{"<"}</button>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: STATUS_COLORS[agent.status] || "#8b949e",
          boxShadow: `0 0 6px ${STATUS_COLORS[agent.status]}40`,
        }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", flex: 1 }}>
          {agent.name}
        </span>
        {agent.costUsd != null && agent.costUsd > 0 && (
          <span style={{ fontSize: 10, color: "#484f58" }}>
            ${agent.costUsd.toFixed(4)}
          </span>
        )}
        <span style={{ fontSize: 11, color: STATUS_COLORS[agent.status] }}>
          {STATUS_LABELS[agent.status]}
        </span>
      </div>

      {/* Messages */}
      <MessageList messages={agent.messages} />

      {/* Input / Actions */}
      <div style={{ borderTop: "1px solid #21262d", padding: 8 }}>
        {canMessage && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Send a follow-up message..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (input.trim()) {
                    onSendMessage(input.trim());
                    setInput("");
                  }
                }
              }}
              style={{
                flex: 1, background: "#161b22", border: "1px solid #21262d", borderRadius: 6,
                color: "#e6edf3", padding: "8px 10px", fontSize: 13, fontFamily: "inherit",
                resize: "none", outline: "none", minHeight: 36, maxHeight: 100,
              }}
              rows={1}
            />
            <button
              onClick={() => {
                if (input.trim()) {
                  onSendMessage(input.trim());
                  setInput("");
                }
              }}
              disabled={!input.trim()}
              style={{
                background: "#238636", color: "#fff", border: "none", borderRadius: 6,
                padding: "0 14px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
                opacity: input.trim() ? 1 : 0.4,
              }}
            >Send</button>
          </div>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          {isActive && (
            <button
              onClick={onStop}
              style={{
                flex: 1, background: "#21262d", color: "#ff7b72", border: "1px solid #ff7b7240",
                borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
              }}
            >Stop</button>
          )}
          {agent.status === "stopped" || agent.status === "error" ? (
            <button
              onClick={onDelete}
              style={{
                flex: 1, background: "#21262d", color: "#ff7b72", border: "1px solid #30363d",
                borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
              }}
            >Remove</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function AgentPanel({ agents, onNewAgent, onStopAgent, onDeleteAgent, onSendMessage }: AgentPanelProps) {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const running = agents.filter((a) => a.status === "running" || a.status === "thinking").length;
  const idle = agents.filter((a) => a.status === "idle").length;
  const errors = agents.filter((a) => a.status === "error").length;

  const selected = selectedAgent ? agents.find((a) => a.id === selectedAgent) : null;

  if (selected) {
    return (
      <AgentDetail
        agent={selected}
        onStop={() => onStopAgent(selected.id)}
        onDelete={() => { onDeleteAgent(selected.id); setSelectedAgent(null); }}
        onSendMessage={(msg) => onSendMessage(selected.id, msg)}
        onBack={() => setSelectedAgent(null)}
      />
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#0d1117" }}>
      <div style={{
        padding: "12px 16px", borderBottom: "1px solid #21262d", display: "flex",
        alignItems: "center", justifyContent: "space-between",
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "#8b949e", letterSpacing: 1 }}>
          Agents
        </span>
        <button
          style={{
            background: "#238636", color: "#fff", border: "none", borderRadius: 6,
            padding: "4px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
          }}
          onClick={onNewAgent}
        >+ Agent</button>
      </div>

      {agents.length > 0 && (
        <div style={{ padding: "8px 16px", fontSize: 11, color: "#8b949e", borderBottom: "1px solid #21262d" }}>
          <span style={{ color: "#3fb950" }}>{running} running</span>
          {" · "}
          <span>{idle} idle</span>
          {" · "}
          <span style={{ color: errors > 0 ? "#ff7b72" : undefined }}>{errors} errors</span>
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        {agents.length === 0 ? (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", color: "#484f58", gap: 8, paddingTop: 60,
          }}>
            <span style={{ fontSize: 32, opacity: 0.4 }}>{">"}_</span>
            <span style={{ fontSize: 13 }}>No agents running</span>
            <span style={{ fontSize: 11 }}>Click "+ Agent" to spawn a Claude session</span>
          </div>
        ) : (
          agents.map((agent) => {
            const lastMsg = [...agent.messages].reverse().find(
              (m) => m.role === "assistant" || (m.role === "tool" && m.toolName)
            );
            return (
              <div
                key={agent.id}
                style={{
                  background: "#161b22", border: "1px solid #21262d", borderRadius: 8,
                  padding: 12, marginBottom: 8, cursor: "pointer",
                }}
                onClick={() => setSelectedAgent(agent.id)}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "#30363d"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "#21262d"; }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: STATUS_COLORS[agent.status] || "#8b949e",
                      boxShadow: `0 0 6px ${STATUS_COLORS[agent.status]}40`,
                    }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>{agent.name}</span>
                  </div>
                  <span style={{ fontSize: 11, color: STATUS_COLORS[agent.status] || "#8b949e" }}>
                    {STATUS_LABELS[agent.status] || agent.status}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 6, lineHeight: 1.4 }}>
                  {agent.task.length > 100 ? agent.task.slice(0, 100) + "..." : agent.task}
                </div>
                {lastMsg && (
                  <div style={{
                    fontSize: 11, color: "#484f58", overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {lastMsg.toolName
                      ? `${lastMsg.toolName}: ${lastMsg.content.split("\n")[0].slice(0, 60)}`
                      : lastMsg.content.slice(0, 80)
                    }
                    {lastMsg.isStreaming && <span style={{ color: "#58a6ff" }}> ▊</span>}
                  </div>
                )}
                {agent.costUsd != null && agent.costUsd > 0 && (
                  <div style={{ fontSize: 10, color: "#484f58", marginTop: 4 }}>
                    ${agent.costUsd.toFixed(4)} · {agent.model || "claude"}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
