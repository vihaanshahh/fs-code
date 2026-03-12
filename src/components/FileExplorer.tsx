import React, { useState, useCallback, useRef, useEffect } from "react";
import type { FileNode } from "../types/index.ts";

interface FileExplorerProps {
  root: FileNode;
  selectedFile?: string;
  onFileOpen: (path: string) => void;
  onCreateFile: (parentPath: string, name: string) => void;
  onCreateFolder: (parentPath: string, name: string) => void;
  onDelete: (path: string) => void;
  onRename: (oldPath: string, newPath: string) => void;
  onRefresh: () => void;
}

const FILE_ICONS: Record<string, string> = {
  tsx: "⚛️", jsx: "⚛️", ts: "📜", js: "📜", css: "🎨", json: "📋",
  md: "📝", py: "🐍", rs: "🦀", go: "🔵", html: "🌐", svg: "🖼️",
  toml: "⚙️", yml: "⚙️", yaml: "⚙️", lock: "🔒", sh: "🔧",
};

function getIcon(node: FileNode, expanded: boolean): string {
  if (node.type === "directory") return expanded ? "📂" : "📁";
  const ext = node.name.split(".").pop()?.toLowerCase() || "";
  return FILE_ICONS[ext] || "📄";
}

const s = {
  container: { height: "100%", display: "flex", flexDirection: "column" as const, background: "#0d1117" },
  header: {
    padding: "12px 16px", borderBottom: "1px solid #21262d", display: "flex",
    alignItems: "center" as const, justifyContent: "space-between" as const,
  },
  title: { fontSize: 11, fontWeight: 600, textTransform: "uppercase" as const, color: "#8b949e", letterSpacing: 1 },
  headerBtns: { display: "flex", gap: 4 },
  headerBtn: {
    background: "none", border: "none", color: "#8b949e", cursor: "pointer",
    fontSize: 14, padding: "2px 4px", borderRadius: 3,
  },
  search: {
    margin: "8px 12px", padding: "5px 8px", background: "#161b22", border: "1px solid #21262d",
    borderRadius: 4, color: "#e6edf3", fontSize: 12, outline: "none", fontFamily: "inherit",
    width: "calc(100% - 24px)",
  },
  tree: { flex: 1, overflow: "auto" as const, padding: "4px 0" },
  item: (depth: number, selected: boolean) => ({
    display: "flex", alignItems: "center" as const, padding: "3px 8px", paddingLeft: 8 + depth * 16,
    cursor: "pointer", fontSize: 13, color: "#e6edf3", userSelect: "none" as const,
    background: selected ? "#1f6feb22" : "transparent",
    borderLeft: selected ? "2px solid #58a6ff" : "2px solid transparent",
  }),
  icon: { marginRight: 6, fontSize: 14, flexShrink: 0 },
  name: { overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const },
  chevron: (expanded: boolean) => ({
    marginRight: 4, fontSize: 10, color: "#8b949e", transition: "transform 0.15s",
    transform: expanded ? "rotate(90deg)" : "rotate(0deg)", width: 12, textAlign: "center" as const,
    flexShrink: 0,
  }),
  context: {
    position: "fixed" as const, background: "#161b22", border: "1px solid #30363d",
    borderRadius: 6, padding: 4, zIndex: 1000, boxShadow: "0 8px 24px #010409aa",
    minWidth: 160,
  },
  contextItem: {
    padding: "6px 12px", fontSize: 12, color: "#e6edf3", cursor: "pointer", borderRadius: 4,
  },
};

interface ContextMenu {
  x: number;
  y: number;
  node: FileNode;
}

function TreeItem({
  node, depth, expanded, selectedFile, filter, onToggle, onFileOpen, onContextMenu,
}: {
  node: FileNode; depth: number; expanded: Set<string>; selectedFile?: string;
  filter: string; onToggle: (path: string) => void; onFileOpen: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}) {
  const isDir = node.type === "directory";
  const isExpanded = expanded.has(node.path);
  const matchesFilter = !filter || node.name.toLowerCase().includes(filter.toLowerCase());

  const children = node.children
    ?.filter((c) => {
      if (!filter) return true;
      if (c.name.toLowerCase().includes(filter.toLowerCase())) return true;
      if (c.type === "directory") return hasMatchingChild(c, filter);
      return false;
    })
    ?.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  if (!matchesFilter && (!children || children.length === 0)) return null;

  return (
    <>
      <div
        style={s.item(depth, node.path === selectedFile)}
        onClick={() => {
          if (isDir) onToggle(node.path);
          else onFileOpen(node.path);
        }}
        onContextMenu={(e) => onContextMenu(e, node)}
        onMouseEnter={(e) => {
          if (node.path !== selectedFile) (e.currentTarget as HTMLElement).style.background = "#161b22";
        }}
        onMouseLeave={(e) => {
          if (node.path !== selectedFile) (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        {isDir && <span style={s.chevron(isExpanded)}>▶</span>}
        {!isDir && <span style={{ width: 16, flexShrink: 0 }} />}
        <span style={s.icon}>{getIcon(node, isExpanded)}</span>
        <span style={s.name}>{node.name}</span>
      </div>
      {isDir && isExpanded && children?.map((child) => (
        <TreeItem
          key={child.path} node={child} depth={depth + 1} expanded={expanded}
          selectedFile={selectedFile} filter={filter} onToggle={onToggle}
          onFileOpen={onFileOpen} onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
}

function hasMatchingChild(node: FileNode, filter: string): boolean {
  if (!node.children) return false;
  return node.children.some(
    (c) => c.name.toLowerCase().includes(filter.toLowerCase()) ||
      (c.type === "directory" && hasMatchingChild(c, filter))
  );
}

export default function FileExplorer({
  root, selectedFile, onFileOpen, onCreateFile, onCreateFolder, onDelete, onRename, onRefresh,
}: FileExplorerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root.path]));
  const [filter, setFilter] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [creating, setCreating] = useState<{ parent: string; type: "file" | "directory" } | null>(null);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const onToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  useEffect(() => {
    if (creating && inputRef.current) inputRef.current.focus();
  }, [creating]);

  const handleCreate = () => {
    if (!creating || !newName.trim()) return;
    if (creating.type === "file") onCreateFile(creating.parent, newName.trim());
    else onCreateFolder(creating.parent, newName.trim());
    setCreating(null);
    setNewName("");
  };

  return (
    <div style={s.container}>
      <div style={s.header}>
        <span style={s.title}>Explorer</span>
        <div style={s.headerBtns}>
          <button style={s.headerBtn} onClick={onRefresh} title="Refresh">↻</button>
          <button style={s.headerBtn} onClick={() => setExpanded(new Set())} title="Collapse All">⊟</button>
        </div>
      </div>
      <input
        style={s.search}
        placeholder="Filter files..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div style={s.tree}>
        {root.children
          ?.sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .map((child) => (
            <TreeItem
              key={child.path} node={child} depth={0} expanded={expanded}
              selectedFile={selectedFile} filter={filter} onToggle={onToggle}
              onFileOpen={onFileOpen} onContextMenu={handleContextMenu}
            />
          ))}
      </div>
      {creating && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid #21262d" }}>
          <input
            ref={inputRef}
            style={{ ...s.search, margin: 0, width: "100%" }}
            placeholder={`New ${creating.type} name...`}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") { setCreating(null); setNewName(""); }
            }}
          />
        </div>
      )}
      {contextMenu && (
        <div style={{ ...s.context, left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.node.type === "directory" && (
            <>
              <div
                style={s.contextItem}
                onClick={() => { setCreating({ parent: contextMenu.node.path, type: "file" }); setContextMenu(null); }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "#21262d"; }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
              >📄 New File</div>
              <div
                style={s.contextItem}
                onClick={() => { setCreating({ parent: contextMenu.node.path, type: "directory" }); setContextMenu(null); }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "#21262d"; }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
              >📁 New Folder</div>
            </>
          )}
          <div
            style={{ ...s.contextItem, color: "#ff7b72" }}
            onClick={() => { onDelete(contextMenu.node.path); setContextMenu(null); }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "#21262d"; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
          >🗑 Delete</div>
        </div>
      )}
    </div>
  );
}
