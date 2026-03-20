import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { collectFiles } from './collector'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-collector-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Helper: create a file with minimal content */
function touch(relativePath: string, content = '// file') {
  const full = path.join(tmpDir, relativePath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

// ── Basic collection ────────────────────────────────────────────────

describe('basic collection', () => {
  it('finds .ts files', () => {
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files).toContain(path.join('src', 'a.ts'))
  })

  it('finds .tsx files', () => {
    touch('src/b.tsx')
    expect(collectFiles(tmpDir)).toContain(path.join('src', 'b.tsx'))
  })

  it('finds .js files', () => {
    touch('lib/c.js')
    expect(collectFiles(tmpDir)).toContain(path.join('lib', 'c.js'))
  })

  it('finds .py files', () => {
    touch('scripts/run.py')
    expect(collectFiles(tmpDir)).toContain(path.join('scripts', 'run.py'))
  })

  it('finds .go files', () => {
    touch('cmd/main.go')
    expect(collectFiles(tmpDir)).toContain(path.join('cmd', 'main.go'))
  })

  it('finds .rs files', () => {
    touch('src/lib.rs')
    expect(collectFiles(tmpDir)).toContain(path.join('src', 'lib.rs'))
  })

  it('returns relative paths', () => {
    touch('src/deep/nested/file.ts')
    const files = collectFiles(tmpDir)
    for (const f of files) {
      expect(path.isAbsolute(f)).toBe(false)
    }
  })

  it('skips node_modules', () => {
    touch('node_modules/pkg/index.js')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.includes('node_modules'))).toBe(false)
  })

  it('skips .git directory', () => {
    touch('.git/config.js')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.includes('.git'))).toBe(false)
  })

  it('skips dist directory', () => {
    touch('dist/bundle.js')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.includes('dist'))).toBe(false)
  })

  it('skips build directory', () => {
    touch('build/output.js')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.includes('build'))).toBe(false)
  })

  it('skips binary extensions (.png)', () => {
    touch('assets/logo.png')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.endsWith('.png'))).toBe(false)
  })

  it('skips binary extensions (.jpg)', () => {
    touch('photo.jpg')
    touch('src/a.ts')
    expect(collectFiles(tmpDir).some(f => f.endsWith('.jpg'))).toBe(false)
  })

  it('skips binary extensions (.exe)', () => {
    touch('app.exe')
    touch('src/a.ts')
    expect(collectFiles(tmpDir).some(f => f.endsWith('.exe'))).toBe(false)
  })

  it('skips unsupported extensions (.txt)', () => {
    touch('readme.txt')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.endsWith('.txt'))).toBe(false)
  })

  it('skips unsupported extensions (.md)', () => {
    touch('README.md')
    touch('src/a.ts')
    expect(collectFiles(tmpDir).some(f => f.endsWith('.md'))).toBe(false)
  })

  it('skips unsupported extensions (.yaml)', () => {
    touch('config.yaml')
    touch('src/a.ts')
    expect(collectFiles(tmpDir).some(f => f.endsWith('.yaml'))).toBe(false)
  })

  it('collects large files (size filtering moved to indexer)', () => {
    const bigContent = Buffer.alloc(513 * 1024, 'x').toString()
    touch('big.ts', bigContent)
    touch('small.ts', '// ok')
    const files = collectFiles(tmpDir)
    // Collector no longer filters by size — indexer handles that.
    // This avoids a redundant statSync per file.
    expect(files).toContain('big.ts')
    expect(files).toContain('small.ts')
  })
})

// ── Gitignore parsing ───────────────────────────────────────────────

describe('gitignore parsing', () => {
  it('exact name match', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'build-output\n')
    fs.mkdirSync(path.join(tmpDir, 'build-output'), { recursive: true })
    touch('build-output/index.js')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.includes('build-output'))).toBe(false)
  })

  it('extension glob (*.log)', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '*.log\n')
    // .log is in SKIP_EXTENSIONS anyway, but .tmp is not a supported extension
    // Test a supported extension via gitignore ext glob
    // Actually *.log would match SKIP_EXTENSIONS first; test *.js via gitignore
    // However *.js in gitignore maps to extGlobs set with the extension
    // The gitignore ext glob is checked against file extension, so *.js would skip .js files
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '*.jsx\n')
    touch('component.jsx')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.endsWith('.jsx'))).toBe(false)
  })

  it('**/*.ext pattern', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '**/*.mjs\n')
    touch('lib/util.mjs')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.endsWith('.mjs'))).toBe(false)
  })

  it('comments and empty lines ignored', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '# comment\n\n*.jsx\n')
    touch('a.jsx')
    touch('a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.endsWith('.jsx'))).toBe(false)
    expect(files.some(f => f.endsWith('.ts'))).toBe(true)
  })

  it('negation lines (!) are ignored', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'generated\n!generated/keep.ts\n')
    fs.mkdirSync(path.join(tmpDir, 'generated'), { recursive: true })
    touch('generated/keep.ts')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    // negation not supported, so generated dir should be skipped entirely
    expect(files.some(f => f.includes('generated'))).toBe(false)
  })

  it('trailing slash stripped', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'output/\n')
    fs.mkdirSync(path.join(tmpDir, 'output'), { recursive: true })
    touch('output/bundle.js')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.includes('output'))).toBe(false)
  })

  it('leading slash stripped', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '/generated-code\n')
    fs.mkdirSync(path.join(tmpDir, 'generated-code'), { recursive: true })
    touch('generated-code/a.js')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.includes('generated-code'))).toBe(false)
  })

  it('no .gitignore file → still works', () => {
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files).toContain(path.join('src', 'a.ts'))
  })
})

// ── Edge cases ──────────────────────────────────────────────────────

describe('edge cases', () => {
  it('empty directory → empty array', () => {
    expect(collectFiles(tmpDir)).toEqual([])
  })

  it('hidden directories skipped (dot-prefixed)', () => {
    touch('.hidden/secret.ts')
    touch('src/a.ts')
    const files = collectFiles(tmpDir)
    expect(files.some(f => f.includes('.hidden'))).toBe(false)
  })

  it('nested directories found', () => {
    touch('a/b/c/d/deep.ts')
    const files = collectFiles(tmpDir)
    expect(files).toContain(path.join('a', 'b', 'c', 'd', 'deep.ts'))
  })

  it('finds multiple supported file types in one pass', () => {
    touch('a.ts')
    touch('b.py')
    touch('c.go')
    touch('d.rs')
    touch('e.json')
    touch('f.css')
    const files = collectFiles(tmpDir)
    expect(files).toHaveLength(6)
  })

  it('root-level files are collected', () => {
    touch('index.ts')
    const files = collectFiles(tmpDir)
    expect(files).toContain('index.ts')
  })
})
