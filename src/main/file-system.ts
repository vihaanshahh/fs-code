import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, extname, resolve, relative } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FileEntry } from '../shared/types'

const execFileAsync = promisify(execFile)

const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '.cache', '__pycache__', '.turbo', 'out', '.DS_Store'])

const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
  '.json': 'json', '.md': 'markdown', '.css': 'css', '.html': 'html', '.py': 'python',
  '.rs': 'rust', '.go': 'go', '.sh': 'shell', '.yml': 'yaml', '.yaml': 'yaml',
  '.toml': 'toml', '.sql': 'sql', '.xml': 'xml',
}

export async function readDirectory(dirPath: string, maxDepth = 4): Promise<FileEntry[]> {
  return buildTree(dirPath, dirPath, 0, maxDepth)
}

async function buildTree(rootPath: string, dirPath: string, depth: number, maxDepth: number): Promise<FileEntry[]> {
  if (depth > maxDepth) return []

  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: FileEntry[] = []
  for (const entry of entries) {
    if (SKIP.has(entry.name) || (entry.name.startsWith('.') && depth > 0)) continue

    const fullPath = join(dirPath, entry.name)
    const relPath = relative(rootPath, fullPath)

    if (entry.isDirectory()) {
      const children = await buildTree(rootPath, fullPath, depth + 1, maxDepth)
      nodes.push({ name: entry.name, path: relPath, type: 'directory', children })
    } else {
      nodes.push({ name: entry.name, path: relPath, type: 'file' })
    }
  }

  // Sort: directories first, then alphabetical
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return nodes
}

export async function readFileContent(filePath: string): Promise<{ content: string; language: string }> {
  const content = await readFile(filePath, 'utf-8')
  const ext = extname(filePath)
  return { content, language: EXT_LANG[ext] || 'plaintext' }
}

export async function writeFileContent(filePath: string, content: string): Promise<void> {
  // Ensure directory exists
  const dir = filePath.substring(0, filePath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(filePath, content, 'utf-8')
}

/**
 * List all files with uncommitted changes (modified, added, deleted, untracked) in a git repo.
 * Returns absolute file paths with their git status.
 */
export async function getGitStatus(cwd: string): Promise<{
  files: { path: string; status: 'modified' | 'added' | 'deleted' | 'untracked' }[]
}> {
  const absCwd = resolve(cwd)

  let repoRoot: string
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: absCwd })
    repoRoot = stdout.trim()
  } catch {
    return { files: [] }
  }

  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-u'], { cwd: repoRoot })
    if (!stdout.trim()) return { files: [] }

    const files: { path: string; status: 'modified' | 'added' | 'deleted' | 'untracked' }[] = []
    for (const line of stdout.trim().split('\n')) {
      if (!line || line.length < 3) continue
      const code = line.substring(0, 2)
      const filePath = line.substring(3).trim()
      if (!filePath) continue
      // Skip renamed files' old path portion
      if (filePath.includes(' -> ')) continue

      const absPath = join(repoRoot, filePath)
      if (code.includes('?')) files.push({ path: absPath, status: 'untracked' })
      else if (code.includes('A')) files.push({ path: absPath, status: 'added' })
      else if (code.includes('D')) files.push({ path: absPath, status: 'deleted' })
      else if (code.includes('M') || code.includes('U')) files.push({ path: absPath, status: 'modified' })
    }
    return { files }
  } catch {
    return { files: [] }
  }
}

/**
 * Get git baseline for a file: returns the content at HEAD and the current working content.
 * Used to compute a "total diff" showing all changes since the last commit.
 */
export async function getGitDiff(filePath: string): Promise<{
  baseContent: string | null
  currentContent: string
  status: 'untracked' | 'modified' | 'added' | 'deleted' | 'unchanged' | 'error'
}> {
  const absPath = resolve(filePath)
  let currentContent: string
  try {
    currentContent = await readFile(absPath, 'utf-8')
  } catch {
    return { baseContent: null, currentContent: '', status: 'error' }
  }

  // Find the git repo root
  let repoRoot: string
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: absPath.substring(0, absPath.lastIndexOf('/')),
    })
    repoRoot = stdout.trim()
  } catch {
    // Not a git repo — everything is "untracked"
    return { baseContent: null, currentContent, status: 'untracked' }
  }

  const relPath = relative(repoRoot, absPath)

  // Check git status for this file
  try {
    const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain', '--', relPath], {
      cwd: repoRoot,
    })

    const statusLine = statusOut.trim()
    if (!statusLine) {
      // No changes — file is unchanged
      return { baseContent: currentContent, currentContent, status: 'unchanged' }
    }

    const code = statusLine.substring(0, 2)
    if (code.includes('?')) {
      // Untracked file
      return { baseContent: null, currentContent, status: 'untracked' }
    }
    if (code.includes('A')) {
      // Newly added (staged)
      return { baseContent: null, currentContent, status: 'added' }
    }
    if (code.includes('D')) {
      // Deleted
      try {
        const { stdout: baseOut } = await execFileAsync('git', ['show', `HEAD:${relPath}`], { cwd: repoRoot })
        return { baseContent: baseOut, currentContent: '', status: 'deleted' }
      } catch {
        return { baseContent: null, currentContent: '', status: 'deleted' }
      }
    }

    // Modified — get the base content from HEAD
    try {
      const { stdout: baseOut } = await execFileAsync('git', ['show', `HEAD:${relPath}`], { cwd: repoRoot })
      return { baseContent: baseOut, currentContent, status: 'modified' }
    } catch {
      // File exists in working tree but not in HEAD (maybe new branch)
      return { baseContent: null, currentContent, status: 'added' }
    }
  } catch {
    return { baseContent: null, currentContent, status: 'error' }
  }
}
