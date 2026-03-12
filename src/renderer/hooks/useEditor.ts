import { useState, useCallback } from 'react'
import { api } from '../lib/api'

export interface OpenFile {
  path: string
  content: string
  language: string
  isDirty: boolean
}

export function useEditor() {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)

  const openFile = useCallback(async (path: string) => {
    const existing = openFiles.find(f => f.path === path)
    if (existing) {
      setActiveFilePath(path)
      return
    }
    try {
      const { content, language } = await api.readFile(path)
      setOpenFiles(prev => [...prev, { path, content, language, isDirty: false }])
      setActiveFilePath(path)
    } catch {}
  }, [openFiles])

  const closeFile = useCallback((path: string) => {
    setOpenFiles(prev => prev.filter(f => f.path !== path))
    setActiveFilePath(prev => {
      if (prev === path) {
        const remaining = openFiles.filter(f => f.path !== path)
        return remaining[remaining.length - 1]?.path || null
      }
      return prev
    })
  }, [openFiles])

  const updateContent = useCallback((path: string, content: string) => {
    setOpenFiles(prev =>
      prev.map(f => f.path === path ? { ...f, content, isDirty: true } : f)
    )
  }, [])

  const saveFile = useCallback(async (path: string) => {
    const file = openFiles.find(f => f.path === path)
    if (!file) return
    await api.writeFile(path, file.content)
    setOpenFiles(prev =>
      prev.map(f => f.path === path ? { ...f, isDirty: false } : f)
    )
  }, [openFiles])

  return {
    openFiles,
    activeFilePath,
    activeFile: openFiles.find(f => f.path === activeFilePath) || null,
    openFile,
    closeFile,
    updateContent,
    saveFile,
    setActiveFilePath,
  }
}
