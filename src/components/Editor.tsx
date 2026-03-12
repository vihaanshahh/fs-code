import React, { useCallback, useMemo } from "react";
import MonacoEditor from "@monaco-editor/react";

interface OpenFile {
  path: string;
  content: string;
  language?: string;
}

interface EditorProps {
  openFiles: OpenFile[];
  activeFile: string | null;
  onFileSelect: (path: string) => void;
  onFileClose: (path: string) => void;
  onContentChange: (path: string, content: string) => void;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
  json: "json", md: "markdown", css: "css", html: "html", py: "python",
  rs: "rust", go: "go", sh: "shell", yml: "yaml", yaml: "yaml", toml: "toml",
  sql: "sql", graphql: "graphql", xml: "xml", svg: "xml",
};

function getLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return EXT_LANG[ext] || "plaintext";
}

function fileName(path: string): string {
  return path.split("/").pop() || path;
}

const styles = {
  container: { display: "flex", flexDirection: "column" as const, height: "100%", background: "#0d1117" },
  tabBar: {
    display: "flex", background: "#161b22", borderBottom: "1px solid #21262d",
    overflowX: "auto" as const, minHeight: 36, alignItems: "center" as const,
  },
  tab: (active: boolean) => ({
    display: "flex", alignItems: "center" as const, gap: 6, padding: "6px 12px",
    fontSize: 12, cursor: "pointer", color: active ? "#e6edf3" : "#8b949e",
    background: active ? "#0d1117" : "transparent",
    borderBottom: active ? "2px solid #58a6ff" : "2px solid transparent",
    borderRight: "1px solid #21262d", whiteSpace: "nowrap" as const, userSelect: "none" as const,
  }),
  closeBtn: {
    marginLeft: 4, fontSize: 14, lineHeight: "14px", borderRadius: 3,
    width: 18, height: 18, display: "flex", alignItems: "center" as const,
    justifyContent: "center" as const, color: "#8b949e", cursor: "pointer",
  },
  empty: {
    flex: 1, display: "flex", alignItems: "center" as const, justifyContent: "center" as const,
    color: "#484f58", fontSize: 14, flexDirection: "column" as const, gap: 8,
  },
};

export default function Editor({ openFiles, activeFile, onFileSelect, onFileClose, onContentChange }: EditorProps) {
  const activeFileData = useMemo(
    () => openFiles.find((f) => f.path === activeFile),
    [openFiles, activeFile]
  );

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (activeFile && value !== undefined) onContentChange(activeFile, value);
    },
    [activeFile, onContentChange]
  );

  return (
    <div style={styles.container}>
      <div style={styles.tabBar}>
        {openFiles.map((f) => (
          <div
            key={f.path}
            style={styles.tab(f.path === activeFile)}
            onClick={() => onFileSelect(f.path)}
          >
            <span>{fileName(f.path)}</span>
            <div
              style={styles.closeBtn}
              onClick={(e) => { e.stopPropagation(); onFileClose(f.path); }}
              onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "#30363d"; }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
            >
              ×
            </div>
          </div>
        ))}
      </div>
      {activeFileData ? (
        <div style={{ flex: 1 }}>
          <MonacoEditor
            height="100%"
            language={activeFileData.language || getLang(activeFileData.path)}
            value={activeFileData.content}
            onChange={handleChange}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: "on",
              wordWrap: "on",
              scrollBeyondLastLine: false,
              padding: { top: 8 },
              fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
              renderLineHighlight: "gutter",
              smoothScrolling: true,
              cursorBlinking: "smooth",
              bracketPairColorization: { enabled: true },
            }}
          />
        </div>
      ) : (
        <div style={styles.empty}>
          <span style={{ fontSize: 48, opacity: 0.3 }}>⚡</span>
          <span>FS Code</span>
          <span style={{ fontSize: 12, color: "#30363d" }}>Open a file to start editing</span>
        </div>
      )}
    </div>
  );
}
