import React, { useState, useEffect, useCallback, useRef } from "react";
import type { FileNode, OpenFile, AgentSession, TerminalTab } from "./types/index.ts";
import Editor from "./components/Editor.tsx";
import FileExplorer from "./components/FileExplorer.tsx";
import AgentPanel from "./components/AgentPanel.tsx";
import Terminal from "./components/Terminal.tsx";

type SidePanel = "explorer" | "agents";

const ACTIVITY_ITEMS: Array<{ id: SidePanel; icon: string; label: string }> = [
  { id: "explorer", icon: "📁", label: "Explorer" },
  { id: "agents", icon: "🤖", label: "Agents" },
];

function NewAgentModal({ onSubmit, onCancel }: { onSubmit: (task: string, name: string) => void; onCancel: () => void }) {
  const [task, setTask] = useState("");
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#010409cc", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={onCancel}>
      <div style={{
        background: "#161b22", border: "1px solid #30363d", borderRadius: 12,
        padding: 24, width: 420, boxShadow: "0 16px 48px #010409",
      }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ color: "#e6edf3", fontSize: 16, marginBottom: 16, fontWeight: 600 }}>
          New Claude Agent
        </h3>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: "#8b949e", marginBottom: 4, display: "block" }}>Name (optional)</label>
          <input
            style={{
              width: "100%", padding: "8px 12px", background: "#0d1117", border: "1px solid #21262d",
              borderRadius: 6, color: "#e6edf3", fontSize: 13, outline: "none", fontFamily: "inherit",
              boxSizing: "border-box",
            }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Agent 1"
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: "#8b949e", marginBottom: 4, display: "block" }}>Task description</label>
          <textarea
            ref={inputRef}
            style={{
              width: "100%", padding: "8px 12px", background: "#0d1117", border: "1px solid #21262d",
              borderRadius: 6, color: "#e6edf3", fontSize: 13, outline: "none", fontFamily: "inherit",
              minHeight: 80, resize: "vertical", boxSizing: "border-box",
            }}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Describe what this agent should do..."
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) { onSubmit(task, name); }
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            style={{
              background: "#21262d", color: "#8b949e", border: "1px solid #30363d",
              borderRadius: 6, padding: "6px 16px", fontSize: 13, cursor: "pointer", fontFamily: "inherit",
            }}
            onClick={onCancel}
          >Cancel</button>
          <button
            style={{
              background: "#238636", color: "#fff", border: "none",
              borderRadius: 6, padding: "6px 16px", fontSize: 13, cursor: "pointer", fontFamily: "inherit",
              opacity: task.trim() ? 1 : 0.5,
            }}
            onClick={() => task.trim() && onSubmit(task, name)}
            disabled={!task.trim()}
          >Start Agent</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [sidePanel, setSidePanel] = useState<SidePanel>("explorer");
  const [showBottom, setShowBottom] = useState(true);
  const [sidePanelWidth, setSidePanelWidth] = useState(260);
  const [bottomHeight, setBottomHeight] = useState(220);
  const [fileTree, setFileTree] = useState<FileNode>({ name: "workspace", path: ".", type: "directory", children: [] });
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSession[]>([]);
  const [termTabs, setTermTabs] = useState<TerminalTab[]>([{ id: "term-1", name: "Terminal" }]);
  const [activeTerm, setActiveTerm] = useState("term-1");
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [resizing, setResizing] = useState<"side" | "bottom" | null>(null);
  const sseConnections = useRef<Map<string, EventSource>>(new Map());

  // Fetch file tree
  const fetchFileTree = useCallback(async () => {
    try {
      const res = await fetch("/api/files?path=.");
      if (res.ok) setFileTree(await res.json());
    } catch {}
  }, []);

  // Fetch agents
  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (res.ok) {
        const data: AgentSession[] = await res.json();
        setAgents(data);

        // Connect SSE for active agents
        for (const agent of data) {
          if (
            (agent.status === "running" || agent.status === "thinking") &&
            !sseConnections.current.has(agent.id)
          ) {
            connectSSE(agent.id);
          }
        }
      }
    } catch {}
  }, []);

  function connectSSE(agentId: string) {
    if (sseConnections.current.has(agentId)) return;

    const es = new EventSource(`/api/agents/${agentId}/stream`);
    sseConnections.current.set(agentId, es);

    es.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(e.data);
        setAgents((prev) =>
          prev.map((a) => {
            if (a.id !== agentId) return a;
            return { ...a, messages: [...a.messages, msg] };
          })
        );
      } catch {}
    });

    es.addEventListener("delta", (e) => {
      try {
        const { delta } = JSON.parse(e.data);
        setAgents((prev) =>
          prev.map((a) => {
            if (a.id !== agentId) return a;
            const messages = [...a.messages];
            const last = messages[messages.length - 1];
            if (last?.isStreaming && last.role === "assistant") {
              messages[messages.length - 1] = { ...last, content: last.content + delta };
            }
            return { ...a, messages };
          })
        );
      } catch {}
    });

    es.addEventListener("status", (e) => {
      try {
        const { status } = JSON.parse(e.data);
        setAgents((prev) =>
          prev.map((a) => (a.id === agentId ? { ...a, status } : a))
        );
        if (status === "idle" || status === "stopped" || status === "error") {
          es.close();
          sseConnections.current.delete(agentId);
        }
      } catch {}
    });

    es.addEventListener("result", (e) => {
      try {
        const { costUsd, model } = JSON.parse(e.data);
        setAgents((prev) =>
          prev.map((a) => (a.id === agentId ? { ...a, costUsd, model } : a))
        );
      } catch {}
    });

    es.onerror = () => {
      es.close();
      sseConnections.current.delete(agentId);
    };
  }

  useEffect(() => { fetchFileTree(); }, [fetchFileTree]);
  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, 3000);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      for (const es of sseConnections.current.values()) es.close();
    };
  }, []);

  // Open file
  const openFile = useCallback(async (path: string) => {
    const existing = openFiles.find((f) => f.path === path);
    if (existing) { setActiveFile(path); return; }
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setOpenFiles((prev) => [...prev, { path, content: data.content, language: data.language }]);
        setActiveFile(path);
      }
    } catch {}
  }, [openFiles]);

  const closeFile = useCallback((path: string) => {
    setOpenFiles((prev) => prev.filter((f) => f.path !== path));
    setActiveFile((prev) => prev === path ? (openFiles.find((f) => f.path !== path)?.path || null) : prev);
  }, [openFiles]);

  const updateFileContent = useCallback((path: string, content: string) => {
    setOpenFiles((prev) => prev.map((f) => f.path === path ? { ...f, content, dirty: true } : f));
  }, []);

  // Save file (Cmd+S)
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        const file = openFiles.find((f) => f.path === activeFile);
        if (file) {
          await fetch("/api/files/write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: file.path, content: file.content }),
          });
          setOpenFiles((prev) => prev.map((f) => f.path === activeFile ? { ...f, dirty: false } : f));
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeFile, openFiles]);

  // Agent actions
  const createAgent = async (task: string, name: string) => {
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, name: name || undefined }),
      });
      if (res.ok) {
        const agent: AgentSession = await res.json();
        setAgents((prev) => [...prev, agent]);
        connectSSE(agent.id);
      }
      setShowNewAgent(false);
      setSidePanel("agents");
    } catch {}
  };

  const stopAgent = async (id: string) => {
    await fetch(`/api/agents/${id}/stop`, { method: "POST" });
    fetchAgents();
  };

  const deleteAgent = async (id: string) => {
    const es = sseConnections.current.get(id);
    if (es) { es.close(); sseConnections.current.delete(id); }
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    setAgents((prev) => prev.filter((a) => a.id !== id));
  };

  const sendMessage = async (id: string, message: string) => {
    try {
      const res = await fetch(`/api/agents/${id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (res.ok) {
        connectSSE(id);
        fetchAgents();
      }
    } catch {}
  };

  // Resizing
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      if (resizing === "side") setSidePanelWidth(Math.max(180, Math.min(500, e.clientX - 48)));
      if (resizing === "bottom") setBottomHeight(Math.max(100, Math.min(600, window.innerHeight - e.clientY)));
    };
    const onUp = () => setResizing(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [resizing]);

  // File ops
  const createFile = async (parentPath: string, name: string) => {
    await fetch("/api/files/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `${parentPath}/${name}`, type: "file" }),
    });
    fetchFileTree();
  };
  const createFolder = async (parentPath: string, name: string) => {
    await fetch("/api/files/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `${parentPath}/${name}`, type: "directory" }),
    });
    fetchFileTree();
  };
  const deleteFile = async (path: string) => {
    await fetch(`/api/files?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    fetchFileTree();
    closeFile(path);
  };

  const runningCount = agents.filter((a) => a.status === "running" || a.status === "thinking").length;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#0d1117", overflow: "hidden" }}>
      {/* Title bar */}
      <div style={{
        height: 38, background: "#010409", borderBottom: "1px solid #21262d",
        display: "flex", alignItems: "center", padding: "0 16px", justifyContent: "space-between",
        WebkitAppRegion: "drag" as any, userSelect: "none",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>⚡</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#e6edf3" }}>FS Code</span>
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 11, color: "#8b949e" }}>
          {runningCount > 0 && (
            <span style={{ color: "#3fb950" }}>● {runningCount} agent{runningCount > 1 ? "s" : ""} running</span>
          )}
          <span onClick={() => setShowBottom(!showBottom)} style={{ cursor: "pointer" }}>
            {showBottom ? "Hide Terminal" : "Show Terminal"}
          </span>
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Activity bar */}
        <div style={{
          width: 48, background: "#010409", borderRight: "1px solid #21262d",
          display: "flex", flexDirection: "column", alignItems: "center", padding: "8px 0", gap: 4,
        }}>
          {ACTIVITY_ITEMS.map((item) => (
            <div
              key={item.id}
              title={item.label}
              style={{
                width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 20, cursor: "pointer", borderRadius: 6,
                background: sidePanel === item.id ? "#21262d" : "transparent",
                borderLeft: sidePanel === item.id ? "2px solid #58a6ff" : "2px solid transparent",
                position: "relative",
              }}
              onClick={() => setSidePanel(item.id)}
            >
              {item.icon}
              {item.id === "agents" && runningCount > 0 && (
                <span style={{
                  position: "absolute", top: 4, right: 4, width: 8, height: 8,
                  borderRadius: "50%", background: "#3fb950", fontSize: 0,
                }} />
              )}
            </div>
          ))}
        </div>

        {/* Side panel */}
        <div style={{ width: sidePanelWidth, borderRight: "1px solid #21262d", overflow: "hidden", flexShrink: 0 }}>
          {sidePanel === "explorer" ? (
            <FileExplorer
              root={fileTree}
              selectedFile={activeFile || undefined}
              onFileOpen={openFile}
              onCreateFile={createFile}
              onCreateFolder={createFolder}
              onDelete={deleteFile}
              onRename={() => {}}
              onRefresh={fetchFileTree}
            />
          ) : (
            <AgentPanel
              agents={agents}
              onNewAgent={() => setShowNewAgent(true)}
              onStopAgent={stopAgent}
              onDeleteAgent={deleteAgent}
              onSendMessage={sendMessage}
            />
          )}
        </div>

        {/* Side panel resize handle */}
        <div
          style={{ width: 4, cursor: "col-resize", background: resizing === "side" ? "#58a6ff" : "transparent" }}
          onMouseDown={() => setResizing("side")}
          onMouseEnter={(e) => { if (!resizing) (e.target as HTMLElement).style.background = "#21262d"; }}
          onMouseLeave={(e) => { if (!resizing) (e.target as HTMLElement).style.background = "transparent"; }}
        />

        {/* Editor + Terminal */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Editor */}
          <div style={{ flex: 1, overflow: "hidden" }}>
            <Editor
              openFiles={openFiles}
              activeFile={activeFile}
              onFileSelect={setActiveFile}
              onFileClose={closeFile}
              onContentChange={updateFileContent}
            />
          </div>

          {/* Bottom resize handle */}
          {showBottom && (
            <div
              style={{ height: 4, cursor: "row-resize", background: resizing === "bottom" ? "#58a6ff" : "transparent" }}
              onMouseDown={() => setResizing("bottom")}
              onMouseEnter={(e) => { if (!resizing) (e.target as HTMLElement).style.background = "#21262d"; }}
              onMouseLeave={(e) => { if (!resizing) (e.target as HTMLElement).style.background = "transparent"; }}
            />
          )}

          {/* Terminal */}
          {showBottom && (
            <div style={{ height: bottomHeight, borderTop: "1px solid #21262d", overflow: "hidden" }}>
              <Terminal
                tabs={termTabs}
                activeTab={activeTerm}
                onTabSelect={setActiveTerm}
                onTabClose={(id) => {
                  setTermTabs((prev) => prev.filter((t) => t.id !== id));
                  if (activeTerm === id) setActiveTerm(termTabs[0]?.id || "");
                }}
                onNewTab={() => {
                  const id = `term-${Date.now()}`;
                  setTermTabs((prev) => [...prev, { id, name: `Terminal ${prev.length + 1}` }]);
                  setActiveTerm(id);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div style={{
        height: 24, background: "#010409", borderTop: "1px solid #21262d",
        display: "flex", alignItems: "center", padding: "0 12px", justifyContent: "space-between",
        fontSize: 11, color: "#8b949e",
      }}>
        <div style={{ display: "flex", gap: 16 }}>
          <span>⚡ FS Code</span>
          <span>{agents.length} agent{agents.length !== 1 ? "s" : ""}</span>
          {runningCount > 0 && <span style={{ color: "#3fb950" }}>● {runningCount} active</span>}
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          {activeFile && <span>{activeFile}</span>}
          <span>{openFiles.length} open</span>
        </div>
      </div>

      {/* New Agent Modal */}
      {showNewAgent && (
        <NewAgentModal
          onSubmit={createAgent}
          onCancel={() => setShowNewAgent(false)}
        />
      )}
    </div>
  );
}
