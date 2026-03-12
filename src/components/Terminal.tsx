import React, { useEffect, useRef, useState, useCallback } from "react";

interface TerminalTab {
  id: string;
  name: string;
}

interface TerminalProps {
  tabs: TerminalTab[];
  activeTab: string;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string) => void;
  onNewTab: () => void;
}

const s = {
  container: { height: "100%", display: "flex", flexDirection: "column" as const, background: "#0d1117" },
  tabBar: {
    display: "flex", background: "#161b22", borderBottom: "1px solid #21262d",
    alignItems: "center" as const, minHeight: 32,
  },
  tab: (active: boolean) => ({
    display: "flex", alignItems: "center" as const, gap: 6, padding: "4px 12px",
    fontSize: 12, cursor: "pointer", color: active ? "#e6edf3" : "#8b949e",
    background: active ? "#0d1117" : "transparent",
    borderBottom: active ? "2px solid #58a6ff" : "2px solid transparent",
    borderRight: "1px solid #21262d",
  }),
  closeBtn: {
    fontSize: 12, color: "#8b949e", cursor: "pointer", marginLeft: 4,
    borderRadius: 3, width: 16, height: 16, display: "flex",
    alignItems: "center" as const, justifyContent: "center" as const,
  },
  addBtn: {
    background: "none", border: "none", color: "#8b949e", cursor: "pointer",
    fontSize: 16, padding: "4px 8px",
  },
  termArea: { flex: 1, position: "relative" as const },
  termContainer: {
    position: "absolute" as const, inset: 0, padding: 8, fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 13, color: "#e6edf3", overflow: "auto" as const,
  },
  input: {
    background: "transparent", border: "none", color: "#e6edf3", outline: "none",
    fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 13, width: "100%",
    caretColor: "#58a6ff",
  },
  line: { lineHeight: 1.5, whiteSpace: "pre-wrap" as const },
  prompt: { color: "#3fb950" },
};

interface TerminalState {
  lines: Array<{ text: string; type: "input" | "output" | "error" }>;
  cwd: string;
}

export default function Terminal({ tabs, activeTab, onTabSelect, onTabClose, onNewTab }: TerminalProps) {
  const [terminals, setTerminals] = useState<Map<string, TerminalState>>(new Map());
  const [inputValue, setInputValue] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const getOrCreateTerminal = useCallback((id: string): TerminalState => {
    const existing = terminals.get(id);
    if (existing) return existing;
    const newTerm: TerminalState = {
      lines: [{ text: "FS Code Terminal — Type commands here", type: "output" }],
      cwd: "~",
    };
    setTerminals((prev) => new Map(prev).set(id, newTerm));
    return newTerm;
  }, [terminals]);

  const currentTerminal = terminals.get(activeTab) || getOrCreateTerminal(activeTab);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [currentTerminal?.lines.length]);

  const handleCommand = async (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    setTerminals((prev) => {
      const next = new Map(prev);
      const term = { ...next.get(activeTab)! };
      term.lines = [...term.lines, { text: `$ ${trimmed}`, type: "input" }];
      next.set(activeTab, term);
      return next;
    });

    try {
      const res = await fetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed, terminalId: activeTab }),
      });
      const data = await res.json();
      setTerminals((prev) => {
        const next = new Map(prev);
        const term = { ...next.get(activeTab)! };
        if (data.stdout) {
          term.lines = [...term.lines, { text: data.stdout, type: "output" }];
        }
        if (data.stderr) {
          term.lines = [...term.lines, { text: data.stderr, type: "error" }];
        }
        if (data.cwd) term.cwd = data.cwd;
        next.set(activeTab, term);
        return next;
      });
    } catch {
      setTerminals((prev) => {
        const next = new Map(prev);
        const term = { ...next.get(activeTab)! };
        term.lines = [...term.lines, { text: "Error: Could not connect to terminal server", type: "error" }];
        next.set(activeTab, term);
        return next;
      });
    }
  };

  return (
    <div style={s.container}>
      <div style={s.tabBar}>
        {tabs.map((tab) => (
          <div key={tab.id} style={s.tab(tab.id === activeTab)} onClick={() => onTabSelect(tab.id)}>
            <span>⬛ {tab.name}</span>
            <div
              style={s.closeBtn}
              onClick={(e) => { e.stopPropagation(); onTabClose(tab.id); }}
            >×</div>
          </div>
        ))}
        <button style={s.addBtn} onClick={onNewTab}>+</button>
      </div>
      <div style={s.termArea} onClick={() => inputRef.current?.focus()}>
        <div ref={containerRef} style={s.termContainer}>
          {currentTerminal.lines.map((line, i) => (
            <div key={i} style={{
              ...s.line,
              color: line.type === "error" ? "#ff7b72" : line.type === "input" ? "#3fb950" : "#e6edf3",
            }}>
              {line.text}
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={s.prompt}>$ </span>
            <input
              ref={inputRef}
              style={s.input}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleCommand(inputValue);
                  setInputValue("");
                }
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
