import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, extname, resolve, relative } from 'node:path'
import type { FileEntry } from '../shared/types'

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
