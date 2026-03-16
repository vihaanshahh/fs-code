import { readdir, readFile, writeFile, mkdir, stat, unlink, access } from 'node:fs/promises'
import { join, extname, resolve, relative, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FileEntry, GitFileStatus } from '../shared/types'

const execFileAsync = promisify(execFile)

const SKIP = new Set(['node_modules', '.git', 'dist', '.next', '.cache', '__pycache__', '.turbo', 'out', '.DS_Store'])

// --- TTL cache for git operations (avoids redundant git process spawns) ---
const TTL_MS = 1500
const gitCacheTTL = new Map<string, { data: any; ts: number }>()

function getCached<T>(key: string): T | undefined {
  const entry = gitCacheTTL.get(key)
  if (entry && Date.now() - entry.ts < TTL_MS) return entry.data as T
  return undefined
}

function setCache(key: string, data: any): void {
  gitCacheTTL.set(key, { data, ts: Date.now() })
}

// Cache repo root lookups (rarely changes)
const repoRootCache = new Map<string, { root: string; ts: number }>()
const REPO_ROOT_TTL = 30_000

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

  const files: FileEntry[] = []
  const dirPromises: Promise<FileEntry>[] = []

  for (const entry of entries) {
    if (SKIP.has(entry.name) || (entry.name.startsWith('.') && depth > 0)) continue

    const fullPath = join(dirPath, entry.name)
    const relPath = relative(rootPath, fullPath)

    if (entry.isDirectory()) {
      // Parallelize sibling directory reads
      dirPromises.push(
        buildTree(rootPath, fullPath, depth + 1, maxDepth).then(children => ({
          name: entry.name, path: relPath, type: 'directory' as const, children,
        }))
      )
    } else {
      files.push({ name: entry.name, path: relPath, type: 'file' })
    }
  }

  const dirs = await Promise.all(dirPromises)
  const nodes = [...dirs, ...files]

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

// ── SCM operations ─────────────────────────────────────────────────

/** Helper: find repo root from a cwd (cached) */
async function findRepoRoot(cwd: string): Promise<string> {
  const absCwd = resolve(cwd)
  const cached = repoRootCache.get(absCwd)
  if (cached && Date.now() - cached.ts < REPO_ROOT_TTL) return cached.root
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: absCwd })
  const root = stdout.trim()
  repoRootCache.set(absCwd, { root, ts: Date.now() })
  return root
}

/**
 * Detailed git status that separates staged, unstaged, and untracked files.
 * Parses both columns of `git status --porcelain`.
 */
export async function getGitStatusDetailed(cwd: string): Promise<{ files: GitFileStatus[] }> {
  const cacheKey = `detailed:${resolve(cwd)}`
  const cached = getCached<{ files: GitFileStatus[] }>(cacheKey)
  if (cached) return cached

  let repoRoot: string
  try {
    repoRoot = await findRepoRoot(cwd)
  } catch {
    return { files: [] }
  }

  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-u'], { cwd: repoRoot })
    if (!stdout.trim()) return { files: [] }

    const files: GitFileStatus[] = []
    for (const line of stdout.trim().split('\n')) {
      if (!line || line.length < 3) continue
      const x = line[0] // index (staged) status
      const y = line[1] // work-tree status
      let filePath = line.substring(3).trim()
      if (!filePath) continue
      // Handle renames: "R  old -> new"
      if (filePath.includes(' -> ')) {
        filePath = filePath.split(' -> ')[1]
      }

      const absPath = join(repoRoot, filePath)
      const name = basename(filePath)

      if (x === '?' && y === '?') {
        // Untracked
        files.push({ path: absPath, basename: name, indexStatus: '?', workTreeStatus: '?', category: 'untracked' })
      } else {
        // If the file has staged changes (index column is not ' ' and not '?')
        if (x !== ' ' && x !== '?') {
          files.push({ path: absPath, basename: name, indexStatus: x, workTreeStatus: ' ', category: 'staged' })
        }
        // If the file also has unstaged changes (work-tree column is not ' ')
        if (y !== ' ' && y !== '?') {
          files.push({ path: absPath, basename: name, indexStatus: ' ', workTreeStatus: y, category: 'unstaged' })
        }
      }
    }
    const result = { files }
    setCache(cacheKey, result)
    return result
  } catch {
    return { files: [] }
  }
}

/** Stage a file */
export async function gitStage(filePath: string, cwd: string): Promise<{ success: boolean; error?: string }> {
  try {
    const repoRoot = await findRepoRoot(cwd)
    const relPath = relative(repoRoot, resolve(filePath))
    await execFileAsync('git', ['add', '--', relPath], { cwd: repoRoot })
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/** Unstage a file */
export async function gitUnstage(filePath: string, cwd: string): Promise<{ success: boolean; error?: string }> {
  try {
    const repoRoot = await findRepoRoot(cwd)
    const relPath = relative(repoRoot, resolve(filePath))
    try {
      await execFileAsync('git', ['restore', '--staged', '--', relPath], { cwd: repoRoot })
    } catch {
      // Fallback for newly added files not yet in HEAD
      await execFileAsync('git', ['rm', '--cached', '--', relPath], { cwd: repoRoot })
    }
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/** Discard changes to a file (revert to HEAD for tracked, delete for untracked) */
export async function gitDiscard(filePath: string, cwd: string): Promise<{ success: boolean; error?: string }> {
  try {
    const repoRoot = await findRepoRoot(cwd)
    const relPath = relative(repoRoot, resolve(filePath))

    // Check if file is untracked
    const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain', '--', relPath], { cwd: repoRoot })
    const statusLine = statusOut.trim()

    if (statusLine.startsWith('??')) {
      // Untracked file — try to trash, fallback to delete
      try {
        const { shell } = await import('electron')
        await shell.trashItem(resolve(filePath))
      } catch {
        await unlink(resolve(filePath))
      }
    } else {
      // Tracked file — restore from HEAD
      await execFileAsync('git', ['checkout', '--', relPath], { cwd: repoRoot })
    }
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Search files in the repo using git ls-files + fuzzy matching.
 * Returns relative paths sorted by match quality.
 */
export async function searchFiles(cwd: string, query: string, limit = 15): Promise<string[]> {
  const absCwd = resolve(cwd)

  let repoRoot: string
  try {
    repoRoot = await findRepoRoot(absCwd)
  } catch {
    repoRoot = absCwd
  }

  // Cache key for file list (refresh every 5s)
  const cacheKey = `files:${repoRoot}`
  let allFiles = getCached<string[]>(cacheKey)

  if (!allFiles) {
    try {
      // Use git ls-files for tracked files + untracked (but not ignored)
      const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: repoRoot,
        maxBuffer: 10 * 1024 * 1024,
      })
      allFiles = stdout.trim().split('\n').filter(Boolean)
      setCache(cacheKey, allFiles)
    } catch {
      // Fallback: no files
      return []
    }
  }

  if (!query) return allFiles.slice(0, limit)

  const q = query.toLowerCase()

  // Score each file: basename match > path match > fuzzy
  const scored: { path: string; score: number }[] = []
  for (const f of allFiles) {
    const lower = f.toLowerCase()
    const base = lower.split('/').pop() || lower

    let score = 0
    if (base === q) {
      score = 100 // exact basename match
    } else if (base.startsWith(q)) {
      score = 80 // basename starts with query
    } else if (base.includes(q)) {
      score = 60 // basename contains query
    } else if (lower.includes(q)) {
      score = 40 // full path contains query
    } else {
      // Fuzzy: check if all chars of query appear in order
      let qi = 0
      for (let i = 0; i < lower.length && qi < q.length; i++) {
        if (lower[i] === q[qi]) qi++
      }
      if (qi === q.length) {
        score = 20
      }
    }

    if (score > 0) scored.push({ path: f, score })
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map(s => s.path)
}

/** Commit staged changes */
export async function gitCommit(message: string, cwd: string): Promise<{ success: boolean; hash?: string; error?: string }> {
  if (!message.trim()) return { success: false, error: 'Commit message cannot be empty' }
  try {
    const repoRoot = await findRepoRoot(cwd)
    const { stdout } = await execFileAsync('git', ['commit', '-m', message], { cwd: repoRoot })
    // Extract hash from output like "[branch abc1234] message"
    const match = stdout.match(/\[[\w/.-]+ ([a-f0-9]+)\]/)
    return { success: true, hash: match?.[1] }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}
