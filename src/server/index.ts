import { Hono } from "hono";
import { cors } from "hono/cors";
import { readdir, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve, relative, extname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSession, AgentMessage } from "../types/index.ts";

const app = new Hono();
app.use("/*", cors());

const WORKSPACE_ROOT = resolve(process.env.WORKSPACE_ROOT || process.cwd());
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".cache", "__pycache__", ".turbo"]);
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

// Security: ensure path is within workspace
function safePath(userPath: string): string {
  const resolved = resolve(WORKSPACE_ROOT, userPath);
  const rel = relative(WORKSPACE_ROOT, resolved);
  if (rel.startsWith("..") || resolve(resolved) !== resolved.replace(/\/$/, "")) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}

// Language detection
const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
  ".json": "json", ".md": "markdown", ".css": "css", ".html": "html", ".py": "python",
  ".rs": "rust", ".go": "go", ".sh": "shell", ".yml": "yaml", ".yaml": "yaml",
  ".toml": "toml", ".sql": "sql", ".xml": "xml", ".svg": "xml",
};

// ============ FILE SYSTEM APIs ============

interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

async function buildTree(dirPath: string, relBase: string, depth: number): Promise<FileNode[]> {
  if (depth > 5) return [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const children = await buildTree(fullPath, relPath, depth + 1);
      nodes.push({ name: entry.name, path: relPath, type: "directory", children });
    } else {
      nodes.push({ name: entry.name, path: relPath, type: "file" });
    }
  }
  return nodes;
}

// GET /api/files - list directory tree
app.get("/api/files", async (c) => {
  try {
    const reqPath = c.req.query("path") || ".";
    const fullPath = safePath(reqPath);
    const children = await buildTree(fullPath, reqPath === "." ? "" : reqPath, 0);
    const rootName = reqPath === "." ? WORKSPACE_ROOT.split("/").pop() || "workspace" : reqPath.split("/").pop() || reqPath;
    return c.json({ name: rootName, path: reqPath, type: "directory", children });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// GET /api/files/read - read file content
app.get("/api/files/read", async (c) => {
  try {
    const reqPath = c.req.query("path");
    if (!reqPath) return c.json({ error: "path required" }, 400);
    const fullPath = safePath(reqPath);
    const content = await readFile(fullPath, "utf-8");
    const ext = extname(fullPath);
    return c.json({ content, language: EXT_LANG[ext] || "plaintext" });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// POST /api/files/write - write file content
app.post("/api/files/write", async (c) => {
  try {
    const { path: reqPath, content } = await c.req.json<{ path: string; content: string }>();
    const fullPath = safePath(reqPath);
    await writeFile(fullPath, content, "utf-8");
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// POST /api/files/create - create file or directory
app.post("/api/files/create", async (c) => {
  try {
    const { path: reqPath, type } = await c.req.json<{ path: string; type: "file" | "directory" }>();
    const fullPath = safePath(reqPath);
    if (type === "directory") {
      await mkdir(fullPath, { recursive: true });
    } else {
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, "", "utf-8");
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// DELETE /api/files - delete file or directory
app.delete("/api/files", async (c) => {
  try {
    const reqPath = c.req.query("path");
    if (!reqPath) return c.json({ error: "path required" }, 400);
    const fullPath = safePath(reqPath);
    await rm(fullPath, { recursive: true, force: true });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// ============ CLAUDE AGENT APIs ============

const agentSessions = new Map<string, AgentSession>();
const agentProcesses = new Map<string, any>();
const agentSSEClients = new Map<string, Set<(data: string) => void>>();

function broadcastToAgent(agentId: string, event: string, data: any) {
  const clients = agentSSEClients.get(agentId);
  if (clients) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const send of clients) {
      try { send(msg); } catch {}
    }
  }
}

function addMessage(agentId: string, msg: AgentMessage) {
  const session = agentSessions.get(agentId);
  if (!session) return;
  // If the last message is a streaming assistant message, finalize it
  const last = session.messages[session.messages.length - 1];
  if (last?.isStreaming && msg.role !== "assistant") {
    last.isStreaming = false;
  }
  session.messages.push(msg);
  broadcastToAgent(agentId, "message", msg);
}

function updateStreamingMessage(agentId: string, textDelta: string) {
  const session = agentSessions.get(agentId);
  if (!session) return;
  const last = session.messages[session.messages.length - 1];
  if (last?.isStreaming && last.role === "assistant") {
    last.content += textDelta;
    broadcastToAgent(agentId, "delta", { delta: textDelta });
  } else {
    // Start new streaming message
    const msg: AgentMessage = {
      role: "assistant",
      content: textDelta,
      timestamp: Date.now(),
      isStreaming: true,
    };
    session.messages.push(msg);
    broadcastToAgent(agentId, "message", msg);
  }
}

function spawnClaude(agentId: string, prompt: string, sessionId?: string) {
  const session = agentSessions.get(agentId);
  if (!session) return;

  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Unset CLAUDECODE to avoid nesting detection
  delete env.CLAUDECODE;

  const proc = Bun.spawn([CLAUDE_PATH, ...args], {
    cwd: session.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  agentProcesses.set(agentId, proc);
  session.status = "running";
  broadcastToAgent(agentId, "status", { status: "running" });

  // Parse stream-json output
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            handleClaudeEvent(agentId, event);
          } catch {
            // non-JSON line, ignore
          }
        }
      }
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          handleClaudeEvent(agentId, JSON.parse(buffer));
        } catch {}
      }
    } catch (err) {
      const sess = agentSessions.get(agentId);
      if (sess && sess.status !== "stopped") {
        sess.status = "error";
        addMessage(agentId, {
          role: "system",
          content: `Stream error: ${err}`,
          timestamp: Date.now(),
        });
        broadcastToAgent(agentId, "status", { status: "error" });
      }
    }

    // Process exited
    const exitCode = await proc.exited;
    const sess = agentSessions.get(agentId);
    if (sess && sess.status !== "stopped") {
      // Finalize any streaming message
      const last = sess.messages[sess.messages.length - 1];
      if (last?.isStreaming) last.isStreaming = false;

      if (exitCode !== 0 && sess.status !== "idle") {
        // Read stderr
        try {
          const stderr = await new Response(proc.stderr).text();
          if (stderr.trim()) {
            addMessage(agentId, {
              role: "system",
              content: `Error: ${stderr.trim()}`,
              timestamp: Date.now(),
            });
          }
        } catch {}
        sess.status = "error";
        broadcastToAgent(agentId, "status", { status: "error" });
      } else {
        sess.status = "idle";
        broadcastToAgent(agentId, "status", { status: "idle" });
      }
    }
    agentProcesses.delete(agentId);
  })();
}

function handleClaudeEvent(agentId: string, event: any) {
  const session = agentSessions.get(agentId);
  if (!session) return;

  switch (event.type) {
    case "system": {
      if (event.subtype === "init") {
        session.sessionId = event.session_id;
        session.model = event.model;
        session.cwd = event.cwd || session.cwd;
        addMessage(agentId, {
          role: "system",
          content: `Session started (${event.model})`,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "assistant": {
      session.status = "thinking";
      broadcastToAgent(agentId, "status", { status: "thinking" });

      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") {
            updateStreamingMessage(agentId, block.text);
          } else if (block.type === "tool_use") {
            // Finalize any streaming text
            const last = session.messages[session.messages.length - 1];
            if (last?.isStreaming) last.isStreaming = false;

            session.status = "running";
            broadcastToAgent(agentId, "status", { status: "running" });

            const inputStr = typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input, null, 2);

            addMessage(agentId, {
              role: "tool",
              content: inputStr,
              toolName: block.name,
              toolId: block.id,
              timestamp: Date.now(),
            });
          }
        }
      }
      break;
    }

    case "tool_result": {
      // tool results come back as content blocks
      if (event.content) {
        let resultText = "";
        for (const block of event.content) {
          if (block.type === "text") {
            resultText += block.text;
          }
        }
        if (resultText) {
          addMessage(agentId, {
            role: "system",
            content: resultText.length > 2000
              ? resultText.slice(0, 2000) + "\n... (truncated)"
              : resultText,
            toolId: event.tool_use_id,
            timestamp: Date.now(),
          });
        }
      }
      break;
    }

    case "result": {
      // Finalize streaming
      const last = session.messages[session.messages.length - 1];
      if (last?.isStreaming) last.isStreaming = false;

      session.costUsd = (session.costUsd || 0) + (event.total_cost_usd || 0);

      if (event.is_error) {
        session.status = "error";
        addMessage(agentId, {
          role: "system",
          content: `Error: ${event.result || "Unknown error"}`,
          timestamp: Date.now(),
        });
      } else {
        session.status = "idle";
      }
      broadcastToAgent(agentId, "status", { status: session.status });
      broadcastToAgent(agentId, "result", {
        costUsd: session.costUsd,
        model: session.model,
      });
      break;
    }

    case "rate_limit_event": {
      if (event.rate_limit_info?.status !== "allowed") {
        addMessage(agentId, {
          role: "system",
          content: `Rate limited. Resets at ${new Date(event.rate_limit_info.resetsAt * 1000).toLocaleTimeString()}`,
          timestamp: Date.now(),
        });
      }
      break;
    }
  }
}

// GET /api/agents - list all agent sessions
app.get("/api/agents", (c) => {
  return c.json(Array.from(agentSessions.values()));
});

// GET /api/agents/:id - single agent
app.get("/api/agents/:id", (c) => {
  const session = agentSessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  return c.json(session);
});

// GET /api/agents/:id/stream - SSE stream for real-time updates
app.get("/api/agents/:id/stream", (c) => {
  const id = c.req.param("id");
  const session = agentSessions.get(id);
  if (!session) return c.json({ error: "not found" }, 404);

  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (data: string) => {
          try { controller.enqueue(encoder.encode(data)); } catch {}
        };

        // Send current state
        send(`event: init\ndata: ${JSON.stringify(session)}\n\n`);

        // Register for updates
        if (!agentSSEClients.has(id)) agentSSEClients.set(id, new Set());
        agentSSEClients.get(id)!.add(send);

        // Cleanup on close - check periodically
        const interval = setInterval(() => {
          try {
            send(": keepalive\n\n");
          } catch {
            agentSSEClients.get(id)?.delete(send);
            clearInterval(interval);
          }
        }, 15000);
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
});

// POST /api/agents - create new agent
app.post("/api/agents", async (c) => {
  try {
    const { task, name, cwd } = await c.req.json<{ task: string; name?: string; cwd?: string }>();
    const id = randomUUID().slice(0, 8);

    const session: AgentSession = {
      id,
      name: name || `Agent ${agentSessions.size + 1}`,
      status: "running",
      task,
      cwd: cwd || WORKSPACE_ROOT,
      messages: [{
        role: "user",
        content: task,
        timestamp: Date.now(),
      }],
      createdAt: Date.now(),
    };

    agentSessions.set(id, session);
    spawnClaude(id, task);

    return c.json(session, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// POST /api/agents/:id/message - send follow-up message
app.post("/api/agents/:id/message", async (c) => {
  try {
    const id = c.req.param("id");
    const session = agentSessions.get(id);
    if (!session) return c.json({ error: "not found" }, 404);

    const { message } = await c.req.json<{ message: string }>();

    // If agent is currently running, we can't send messages
    if (agentProcesses.has(id)) {
      return c.json({ error: "Agent is currently running. Wait for it to finish or stop it first." }, 400);
    }

    if (!session.sessionId) {
      return c.json({ error: "No session ID - cannot resume" }, 400);
    }

    addMessage(id, {
      role: "user",
      content: message,
      timestamp: Date.now(),
    });

    // Resume the claude session with the new message
    spawnClaude(id, message, session.sessionId);

    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// POST /api/agents/:id/stop
app.post("/api/agents/:id/stop", (c) => {
  const id = c.req.param("id");
  const session = agentSessions.get(id);
  if (!session) return c.json({ error: "not found" }, 404);

  const proc = agentProcesses.get(id);
  if (proc) {
    try { proc.kill(); } catch {}
    agentProcesses.delete(id);
  }
  session.status = "stopped";
  // Finalize streaming
  const last = session.messages[session.messages.length - 1];
  if (last?.isStreaming) last.isStreaming = false;

  addMessage(id, { role: "system", content: "Agent stopped by user", timestamp: Date.now() });
  broadcastToAgent(id, "status", { status: "stopped" });
  return c.json({ ok: true });
});

// DELETE /api/agents/:id - remove agent
app.delete("/api/agents/:id", (c) => {
  const id = c.req.param("id");
  const proc = agentProcesses.get(id);
  if (proc) {
    try { proc.kill(); } catch {}
    agentProcesses.delete(id);
  }
  agentSessions.delete(id);
  agentSSEClients.delete(id);
  return c.json({ ok: true });
});

// ============ TERMINAL API ============

// POST /api/terminal/exec - execute command
app.post("/api/terminal/exec", async (c) => {
  try {
    const { command } = await c.req.json<{ command: string; terminalId?: string }>();

    // Security: block dangerous commands
    const blocked = ["rm -rf /", "mkfs", "dd if=", "> /dev/sd"];
    if (blocked.some((b) => command.includes(b))) {
      return c.json({ stderr: "Command blocked for safety", stdout: "", exitCode: 1 });
    }

    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: WORKSPACE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return c.json({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode, cwd: WORKSPACE_ROOT });
  } catch (e: any) {
    return c.json({ stderr: e.message, stdout: "", exitCode: 1 });
  }
});

// ============ STATIC FILES (PRODUCTION) ============

app.get("/*", async (c) => {
  const url = new URL(c.req.url);
  let filePath = join(resolve("dist/client"), url.pathname === "/" ? "index.html" : url.pathname);

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      const content = await readFile(filePath);
      const ext = extname(filePath);
      const contentType: Record<string, string> = {
        ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
        ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
      };
      return new Response(content, {
        headers: { "Content-Type": contentType[ext] || "application/octet-stream" },
      });
    }
  } catch {}

  // SPA fallback
  try {
    const indexHtml = await readFile(join(resolve("dist/client"), "index.html"));
    return new Response(indexHtml, { headers: { "Content-Type": "text/html" } });
  } catch {
    return c.text("Not found", 404);
  }
});

// ============ START SERVER ============

const PORT = parseInt(process.env.PORT || "5174", 10);

console.log(`
  ⚡ FS Code Server
  → http://localhost:${PORT}
  → Workspace: ${WORKSPACE_ROOT}
  → Claude CLI: ${CLAUDE_PATH}
`);

export default {
  port: PORT,
  fetch: app.fetch,
};
