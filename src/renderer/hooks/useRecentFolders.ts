const STORAGE_KEY = 'fs-code-recent-folders'
const MAX_RECENT = 5

type RecentFolder = { path: string; name: string; lastUsed: number }

function basename(p: string): string {
  return p.replace(/\/$/, '').split('/').pop() || p
}

export function getRecentFolders(): RecentFolder[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

export function addRecentFolder(path: string): void {
  const existing = getRecentFolders().filter(f => f.path !== path)
  const entry: RecentFolder = { path, name: basename(path), lastUsed: Date.now() }
  const updated = [entry, ...existing].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
  } catch { /* quota exceeded — ignore */ }
}
