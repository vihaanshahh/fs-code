/**
 * File collector — walks project directory to find source files.
 * Direct copy from claude-ex/src/indexer/collector.ts (no changes needed).
 */

import * as fs from 'fs'
import * as path from 'path'

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  '.next', '.nuxt', '__pycache__', '.pytest_cache', 'target', 'vendor',
  '.codex', '.claude', '.local', 'coverage', '.vscode', '.idea', 'venv', '.venv',
  '.env', '.tox', 'bower_components', '.cache', '.parcel-cache',
  'tmp', 'temp', '.turbo', '.vercel', '.netlify',
])

const SKIP_EXTENSIONS = new Set([
  '.lock', '.log', '.map', '.min.js', '.min.css',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm', '.ogg',
  '.zip', '.tar', '.gz', '.bz2', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.pyc', '.pyo', '.class', '.jar',
  '.db', '.sqlite', '.sqlite3',
  '.bin', '.dat', '.img', '.iso',
])

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs',
  '.py',
  '.rs',
  '.go',
  '.sh', '.bash',
  '.c', '.h',
  '.cpp', '.cc', '.hpp',
  '.json',
  '.css',
  '.html', '.htm',
])

interface GitignoreRules {
  /** Exact directory/file names (no wildcards, no slashes) */
  exactNames: Set<string>
  /** Simple glob patterns like "*.log", "*.tmp" — match extension */
  extGlobs: Set<string>
}

function parseGitignore(rootDir: string): GitignoreRules {
  const rules: GitignoreRules = { exactNames: new Set(), extGlobs: new Set() }
  const gitignorePath = path.join(rootDir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) return rules

  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
      const name = trimmed.replace(/\/$/, '').replace(/^\//, '')

      // "*.ext" or "**/*.ext" → extension-based glob
      const extMatch = name.match(/^\*?\*?\/??\*(\.\w+)$/)
      if (extMatch) {
        rules.extGlobs.add(extMatch[1].toLowerCase())
        continue
      }

      // Simple name without path separators or complex globs → exact match
      if (!name.includes('/') && !name.includes('*')) {
        rules.exactNames.add(name)
      }
      // Complex patterns (paths with /, negations) are already handled
      // by SKIP_DIRS for common cases — skip rather than mis-parse
    }
  } catch {
    // ignore read errors
  }
  return rules
}

/** Max directory depth to prevent stack overflow on pathological repos */
const MAX_DEPTH = 30

export function collectFiles(rootDir: string): string[] {
  const files: string[] = []
  const gitignore = parseGitignore(rootDir)

  function walk(dir: string, depth: number) {
    if (depth > MAX_DEPTH) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const name = entry.name

      if (entry.isDirectory()) {
        if (name.startsWith('.') || SKIP_DIRS.has(name) || gitignore.exactNames.has(name)) continue
        walk(path.join(dir, name), depth + 1)
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase()
        if (SKIP_EXTENSIONS.has(ext)) continue
        if (gitignore.extGlobs.has(ext)) continue
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue

        // No statSync here — the indexer does stat+read in one pass.
        // This avoids doubling filesystem calls for every file.
        files.push(path.relative(rootDir, path.join(dir, name)))
      }
    }
  }

  walk(rootDir, 0)
  return files
}
