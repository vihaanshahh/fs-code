/**
 * Tests that sendPrompt awaits the codex promise before building options.
 *
 * This validates the fix for the race condition where codex MCP servers
 * and hooks were missed because acquireManager() hadn't resolved yet.
 *
 * We test the pattern directly without importing agent.ts (which pulls
 * in Electron, SDK, etc.) — we replicate the exact logic from sendPrompt.
 */

import { describe, it, expect, vi } from 'vitest'

// Minimal mock of what CodexManager exposes
interface MockCodexManager {
  getMcpServers(): Record<string, unknown>
  getHooks(): Record<string, unknown[]>
}

// Replicate the AgentState shape relevant to codex
interface AgentState {
  providerId: string
  codex: MockCodexManager | null
  codexPromise: Promise<MockCodexManager | null>
}

/**
 * This replicates the exact logic from sendPrompt in agent.ts:
 *
 *   if (state.providerId === 'claude' && !state.codex) {
 *     await state.codexPromise
 *   }
 *   const codexMcp = state.providerId === 'claude' && state.codex ? state.codex.getMcpServers() : undefined
 *   const codexHooks = state.providerId === 'claude' && state.codex ? state.codex.getHooks() : undefined
 */
async function buildCodexOptions(state: AgentState) {
  if (state.providerId === 'claude' && !state.codex) {
    await state.codexPromise
  }
  const codexMcp = state.providerId === 'claude' && state.codex ? state.codex.getMcpServers() : undefined
  const codexHooks = state.providerId === 'claude' && state.codex ? state.codex.getHooks() : undefined
  return { mcpServers: codexMcp, hooks: codexHooks }
}

function createMockCodex(): MockCodexManager {
  return {
    getMcpServers: () => ({ codex: { type: 'mock-mcp' } }),
    getHooks: () => ({ SessionStart: [{ type: 'mock-hook' }] }),
  }
}

describe('codex await in sendPrompt', () => {
  it('awaits codexPromise when codex is not yet resolved', async () => {
    const mockCodex = createMockCodex()

    // Simulate the race: codex is null initially, promise resolves later
    let resolveCodex!: (v: MockCodexManager) => void
    const codexPromise = new Promise<MockCodexManager>((resolve) => {
      resolveCodex = resolve
    })

    const state: AgentState = {
      providerId: 'claude',
      codex: null,
      // The promise sets state.codex when it resolves (like acquireManager does)
      codexPromise: codexPromise.then((codex) => {
        state.codex = codex
        return codex
      }),
    }

    // Start building options — should block on codexPromise
    const optionsPromise = buildCodexOptions(state)

    // Codex hasn't resolved yet
    expect(state.codex).toBeNull()

    // Now resolve the codex promise (simulating acquireManager finishing)
    resolveCodex(mockCodex)

    const options = await optionsPromise
    expect(state.codex).toBe(mockCodex)
    expect(options.mcpServers).toEqual({ codex: { type: 'mock-mcp' } })
    expect(options.hooks).toEqual({ SessionStart: [{ type: 'mock-hook' }] })
  })

  it('does not block when codex is already resolved', async () => {
    const mockCodex = createMockCodex()

    const state: AgentState = {
      providerId: 'claude',
      codex: mockCodex, // Already set
      codexPromise: Promise.resolve(mockCodex),
    }

    const options = await buildCodexOptions(state)
    expect(options.mcpServers).toEqual({ codex: { type: 'mock-mcp' } })
    expect(options.hooks).toEqual({ SessionStart: [{ type: 'mock-hook' }] })
  })

  it('returns undefined mcp/hooks for non-claude providers', async () => {
    const state: AgentState = {
      providerId: 'openai',
      codex: null,
      codexPromise: Promise.resolve(null),
    }

    const options = await buildCodexOptions(state)
    expect(options.mcpServers).toBeUndefined()
    expect(options.hooks).toBeUndefined()
  })

  it('handles codex init failure gracefully (promise resolves to null)', async () => {
    const state: AgentState = {
      providerId: 'claude',
      codex: null,
      // Simulates acquireManager catching an error and returning null
      codexPromise: Promise.resolve(null),
    }

    const options = await buildCodexOptions(state)
    expect(options.mcpServers).toBeUndefined()
    expect(options.hooks).toBeUndefined()
  })

  it('awaits slow codex init without losing MCP servers', async () => {
    const mockCodex = createMockCodex()

    // Simulate a slow init (e.g. large repo indexing)
    const state: AgentState = {
      providerId: 'claude',
      codex: null,
      codexPromise: new Promise((resolve) => {
        setTimeout(() => {
          state.codex = mockCodex
          resolve(mockCodex)
        }, 50)
      }),
    }

    const options = await buildCodexOptions(state)
    expect(options.mcpServers).toBeDefined()
    expect(options.hooks).toBeDefined()
  })

  it('without the fix, codex would be missed (demonstrates the bug)', async () => {
    const mockCodex = createMockCodex()

    let resolveCodex!: (v: MockCodexManager) => void
    const codexPromise = new Promise<MockCodexManager>((resolve) => {
      resolveCodex = resolve
    })

    const state: AgentState = {
      providerId: 'claude',
      codex: null,
      codexPromise: codexPromise.then((codex) => {
        state.codex = codex
        return codex
      }),
    }

    // OLD behavior (no await): reads codex while it's still null
    const codexMcpOld = state.providerId === 'claude' && state.codex ? state.codex.getMcpServers() : undefined
    expect(codexMcpOld).toBeUndefined() // BUG: codex missed!

    // Resolve codex
    resolveCodex(mockCodex)
    await codexPromise

    // NEW behavior (with await): gets the codex
    const options = await buildCodexOptions(state)
    expect(options.mcpServers).toBeDefined() // FIXED: codex included
  })
})
