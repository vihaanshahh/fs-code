import { describe, it, expect } from 'vitest'
import { extractTextFromJson, JsonlProvider } from './jsonl-provider'
import type { JsonlProviderConfig } from './jsonl-provider'
import type { ModelInfo } from './provider'

// ── extractTextFromJson ─────────────────────────────────────────────

describe('extractTextFromJson', () => {
  // Direct string fields
  it('extracts { text: "..." }', () => {
    expect(extractTextFromJson({ text: 'hello' })).toBe('hello')
  })

  it('extracts { content: "..." }', () => {
    expect(extractTextFromJson({ content: 'hello' })).toBe('hello')
  })

  it('extracts { output: "..." }', () => {
    expect(extractTextFromJson({ output: 'hello' })).toBe('hello')
  })

  it('extracts { response: "..." }', () => {
    expect(extractTextFromJson({ response: 'hello' })).toBe('hello')
  })

  it('extracts { answer: "..." }', () => {
    expect(extractTextFromJson({ answer: 'hello' })).toBe('hello')
  })

  it('extracts { result: "..." }', () => {
    expect(extractTextFromJson({ result: 'hello' })).toBe('hello')
  })

  it('extracts { delta: "..." }', () => {
    expect(extractTextFromJson({ delta: 'hello' })).toBe('hello')
  })

  // OpenAI chat format: message.content
  it('extracts { message: { content: "..." } }', () => {
    expect(extractTextFromJson({ message: { content: 'hello' } })).toBe('hello')
  })

  it('extracts { message: { text: "..." } }', () => {
    expect(extractTextFromJson({ message: { text: 'hello' } })).toBe('hello')
  })

  // OpenAI streaming: choices[].delta.content
  it('extracts { choices: [{ delta: { content: "..." } }] }', () => {
    expect(extractTextFromJson({ choices: [{ delta: { content: 'hello' } }] })).toBe('hello')
  })

  // OpenAI completion: choices[].message.content
  it('extracts { choices: [{ message: { content: "..." } }] }', () => {
    expect(extractTextFromJson({ choices: [{ message: { content: 'hello' } }] })).toBe('hello')
  })

  // OpenAI choice with text field
  it('extracts { choices: [{ text: "..." }] }', () => {
    expect(extractTextFromJson({ choices: [{ text: 'hello' }] })).toBe('hello')
  })

  // Gemini format
  it('extracts Gemini { candidates: [{ content: { parts: [{ text: "..." }] } }] }', () => {
    expect(extractTextFromJson({
      candidates: [{ content: { parts: [{ text: 'hello' }] } }],
    })).toBe('hello')
  })

  // Data wrapper
  it('extracts { data: { text: "..." } }', () => {
    expect(extractTextFromJson({ data: { text: 'hello' } })).toBe('hello')
  })

  it('extracts { data: { content: "..." } }', () => {
    expect(extractTextFromJson({ data: { content: 'hello' } })).toBe('hello')
  })

  // Empty / null / missing
  it('returns null for empty object', () => {
    expect(extractTextFromJson({})).toBeNull()
  })

  it('returns null when text field is empty string', () => {
    expect(extractTextFromJson({ text: '' })).toBeNull()
  })

  it('returns null when content field is empty string', () => {
    expect(extractTextFromJson({ content: '' })).toBeNull()
  })

  it('returns null for non-string values (number)', () => {
    expect(extractTextFromJson({ text: 42 })).toBeNull()
  })

  it('returns null for non-string values (boolean)', () => {
    expect(extractTextFromJson({ content: true })).toBeNull()
  })

  it('returns null for non-string values (array)', () => {
    expect(extractTextFromJson({ text: ['a', 'b'] })).toBeNull()
  })

  it('returns null for null values', () => {
    expect(extractTextFromJson({ text: null })).toBeNull()
  })

  it('returns null for { message: null }', () => {
    expect(extractTextFromJson({ message: null })).toBeNull()
  })

  it('returns null for { choices: [] } (empty array)', () => {
    expect(extractTextFromJson({ choices: [] })).toBeNull()
  })

  it('returns null for { candidates: [] } (empty array)', () => {
    expect(extractTextFromJson({ candidates: [] })).toBeNull()
  })

  it('returns null for { data: null }', () => {
    expect(extractTextFromJson({ data: null })).toBeNull()
  })

  // Priority: direct fields checked first
  it('direct field wins over nested (first match wins)', () => {
    expect(extractTextFromJson({
      text: 'direct',
      message: { content: 'nested' },
    })).toBe('direct')
  })

  it('handles metadata-only objects (status events)', () => {
    expect(extractTextFromJson({ type: 'status', code: 200 })).toBeNull()
  })
})

// ── JsonlProvider construction & lifecycle ───────────────────────────

describe('JsonlProvider', () => {
  const testModels: ModelInfo[] = [
    { id: 'model-a', name: 'Model A' },
    { id: 'model-b', name: 'Model B' },
  ]

  function makeConfig(overrides?: Partial<JsonlProviderConfig>): JsonlProviderConfig {
    return {
      id: 'test-provider',
      displayName: 'Test Provider',
      binary: 'test-cli',
      buildArgs: () => ['--prompt', 'hello'],
      buildEnv: () => ({}),
      parseEvent: () => [],
      models: testModels,
      defaultModel: 'model-a',
      ...overrides,
    }
  }

  it('sets id from config', () => {
    const p = new JsonlProvider(makeConfig({ id: 'my-id' }))
    expect(p.id).toBe('my-id')
  })

  it('sets displayName from config', () => {
    const p = new JsonlProvider(makeConfig({ displayName: 'Cool CLI' }))
    expect(p.displayName).toBe('Cool CLI')
  })

  it('getCurrentModel() returns default model', () => {
    const p = new JsonlProvider(makeConfig({ defaultModel: 'model-b' }))
    expect(p.getCurrentModel()).toBe('model-b')
  })

  it('setModel() updates current model', () => {
    const p = new JsonlProvider(makeConfig())
    p.setModel('model-b')
    expect(p.getCurrentModel()).toBe('model-b')
  })

  it('getModels() returns config models', async () => {
    const p = new JsonlProvider(makeConfig())
    const models = await p.getModels()
    expect(models).toEqual(testModels)
  })

  it('stop() when no child is running (no-op, no crash)', () => {
    const p = new JsonlProvider(makeConfig())
    expect(() => p.stop()).not.toThrow()
  })

  it('dispose() when no child is running (no-op, no crash)', () => {
    const p = new JsonlProvider(makeConfig())
    expect(() => p.dispose()).not.toThrow()
  })

  it('setPermissionMode() is a no-op (no crash)', () => {
    const p = new JsonlProvider(makeConfig())
    expect(() => p.setPermissionMode('default')).not.toThrow()
  })

  it('setPermissionHandler() stores handler without crash', () => {
    const p = new JsonlProvider(makeConfig())
    expect(() => p.setPermissionHandler(async () => ({ behavior: 'allow' as const, requestId: 'x' }))).not.toThrow()
  })
})
