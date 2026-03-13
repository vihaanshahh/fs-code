import { useMemo, useState, useEffect } from 'react'
import { api } from '../lib/api'
import type { UIMessage, TrackedFile, FileOperation, FileOperationType } from '../../shared/types'

// Persistent cache keyed by cwd — survives hook re-mounts / agent switches
const gitCache = new Map<string, TrackedFile[]>()

function basename(path: string): string {
  return path.split('/').pop() || path
}

function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  return (obj.file_path || obj.path || obj.notebook_path || null) as string | null
}

function extractBashPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const obj = input as Record<string, unknown>
  const cmd = (obj.command || '') as string
  if (!cmd) return []

  const paths: string[] = []
  const filePattern = /(?:^|\s)((?:\.{0,2}\/)?[\w\-./]+\.[\w]+)/g
  let match
  while ((match = filePattern.exec(cmd)) !== null) {
    const p = match[1]
    if (!p.startsWith('-') && !p.startsWith('http') && p.includes('/')) {
      paths.push(p)
    }
  }
  return paths
}

function getOperationType(toolName: string, input: unknown): FileOperationType {
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') return 'read'
  if (toolName === 'Write' || toolName === 'NotebookEdit') return 'create'
  if (toolName === 'Edit') return 'write'
  if (toolName === 'Bash') {
    const cmd = (input as Record<string, unknown>)?.command as string || ''
    if (/\b(>|>>|tee|cp|mv|mkdir|touch|echo\s.*>|write|edit)\b/i.test(cmd)) return 'write'
    return 'execute'
  }
  return 'read'
}

function extractEditContent(input: unknown): { oldStr?: string; newStr?: string } {
  if (!input || typeof input !== 'object') return {}
  const obj = input as Record<string, unknown>
  const oldStr = typeof obj.old_string === 'string' ? obj.old_string : undefined
  const newStr = typeof obj.new_string === 'string' ? obj.new_string : undefined
  return { oldStr, newStr }
}

function extractWriteContent(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const obj = input as Record<string, unknown>
  return typeof obj.content === 'string' ? obj.content : undefined
}

const GIT_STATUS_TO_OP: Record<string, FileOperationType> = {
  modified: 'write',
  added: 'create',
  deleted: 'write',
  untracked: 'create',
}

export function useFileActivity(
  messages: UIMessage[],
  agentId?: string,
  agentName?: string,
  cwd?: string,
): {
  files: TrackedFile[]
  totalFiles: number
  recentFile: TrackedFile | null
  loading: boolean
} {
  // Start with cached data if available, so UI is instant
  const [gitFiles, setGitFiles] = useState<TrackedFile[]>(() =>
    cwd ? (gitCache.get(cwd) || []) : []
  )
  const [loading, setLoading] = useState(false)

  // Fetch git status when cwd changes
  useEffect(() => {
    if (!cwd) {
      setGitFiles([])
      return
    }

    // Use cache immediately if available
    const cached = gitCache.get(cwd)
    if (cached) {
      setGitFiles(cached)
    }

    setLoading(true)
    api.gitStatus(cwd).then((result) => {
      if (!result?.files?.length) {
        setGitFiles([])
        gitCache.delete(cwd)
        return
      }
      const now = Date.now()
      const tracked: TrackedFile[] = result.files.map((f: { path: string; status: string }) => ({
        path: f.path,
        basename: basename(f.path),
        operations: [{
          type: GIT_STATUS_TO_OP[f.status] || 'write',
          toolUseId: `git-${f.status}-${f.path}`,
          toolName: `git:${f.status}`,
          timestamp: now,
        }],
        firstSeen: now,
        lastSeen: now,
      }))
      gitCache.set(cwd, tracked)
      setGitFiles(tracked)
    }).catch(() => {
      setGitFiles([])
    }).finally(() => {
      setLoading(false)
    })
  }, [cwd])

  // Session files from agent messages
  const sessionFiles = useMemo(() => {
    const fileMap = new Map<string, TrackedFile>()

    const trackFile = (path: string, op: FileOperation) => {
      const existing = fileMap.get(path)
      if (existing) {
        existing.operations.push(op)
        existing.lastSeen = op.timestamp
      } else {
        fileMap.set(path, {
          path,
          basename: basename(path),
          operations: [op],
          firstSeen: op.timestamp,
          lastSeen: op.timestamp,
        })
      }
    }

    for (const msg of messages) {
      if (msg.type !== 'tool-use') continue

      const { toolName, toolUseId, input, ts } = msg
      const opType = getOperationType(toolName, input)

      const op: FileOperation = {
        type: opType,
        toolUseId,
        toolName,
        timestamp: ts,
        agentId,
        agentName,
      }

      if (toolName === 'Edit') {
        const { oldStr, newStr } = extractEditContent(input)
        op.editOldString = oldStr
        op.editNewString = newStr
      }

      if (toolName === 'Write' || toolName === 'NotebookEdit') {
        op.writeContent = extractWriteContent(input)
      }

      const filePath = extractFilePath(input)
      if (filePath) {
        trackFile(filePath, op)
      }

      if (toolName === 'Bash') {
        const paths = extractBashPaths(input)
        for (const p of paths) {
          trackFile(p, { ...op, type: 'execute' })
        }
      }
    }

    return Array.from(fileMap.values())
  }, [messages, agentId, agentName])

  // Merge: session files take priority, then git files not already tracked
  const merged = useMemo(() => {
    const sessionPaths = new Set(sessionFiles.map(f => f.path))
    const combined = [
      ...sessionFiles,
      ...gitFiles.filter(gf => !sessionPaths.has(gf.path)),
    ]
    combined.sort((a, b) => b.lastSeen - a.lastSeen)
    return combined
  }, [sessionFiles, gitFiles])

  const recentFile = merged.length > 0 ? merged[0] : null

  return { files: merged, totalFiles: merged.length, recentFile, loading }
}
