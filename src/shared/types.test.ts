import { describe, it, expect } from 'vitest'
import {
  PROVIDER_CONFIGS,
  PERMISSION_MODE_LABELS,
  IPC,
} from './types'
import type { ProviderId, PermissionMode } from './types'

// ── PROVIDER_CONFIGS ────────────────────────────────────────────────

describe('PROVIDER_CONFIGS', () => {
  const allProviderIds: ProviderId[] = ['claude', 'copilot', 'openai', 'gemini']

  it('all ProviderId values have a config entry', () => {
    for (const id of allProviderIds) {
      expect(PROVIDER_CONFIGS[id]).toBeDefined()
    }
  })

  it('no extra entries beyond known provider IDs', () => {
    expect(Object.keys(PROVIDER_CONFIGS).sort()).toEqual([...allProviderIds].sort())
  })

  for (const id of ['claude', 'copilot', 'openai', 'gemini'] as ProviderId[]) {
    describe(`${id} config`, () => {
      const config = PROVIDER_CONFIGS[id]

      it('has required fields', () => {
        expect(config.id).toBeDefined()
        expect(config.displayName).toBeDefined()
        expect(config.shortLabel).toBeDefined()
        expect(config.color).toBeDefined()
        expect(config.authType).toBeDefined()
      })

      it('config.id matches its key', () => {
        expect(config.id).toBe(id)
      })

      it('displayName is a non-empty string', () => {
        expect(typeof config.displayName).toBe('string')
        expect(config.displayName.length).toBeGreaterThan(0)
      })

      it('shortLabel is a non-empty string', () => {
        expect(typeof config.shortLabel).toBe('string')
        expect(config.shortLabel.length).toBeGreaterThan(0)
      })

      it('color is a valid hex string', () => {
        expect(config.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
      })

      it('authType is one of cli-login | api-key | oauth', () => {
        expect(['cli-login', 'api-key', 'oauth']).toContain(config.authType)
      })

      it('has boolean capability flags', () => {
        expect(typeof config.supportsResume).toBe('boolean')
        expect(typeof config.supportsPermissions).toBe('boolean')
        expect(typeof config.supportsModelSwitch).toBe('boolean')
      })
    })
  }
})

// ── PERMISSION_MODE_LABELS ──────────────────────────────────────────

describe('PERMISSION_MODE_LABELS', () => {
  const allModes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']

  it('all PermissionMode values have labels', () => {
    for (const mode of allModes) {
      expect(PERMISSION_MODE_LABELS[mode]).toBeDefined()
    }
  })

  it('no extra entries beyond known modes', () => {
    expect(Object.keys(PERMISSION_MODE_LABELS).sort()).toEqual([...allModes].sort())
  })

  it('labels are non-empty strings', () => {
    for (const label of Object.values(PERMISSION_MODE_LABELS)) {
      expect(typeof label).toBe('string')
      expect(label.length).toBeGreaterThan(0)
    }
  })
})

// ── IPC channels ────────────────────────────────────────────────────

describe('IPC channels', () => {
  const allValues = Object.values(IPC)

  it('all values are unique (no duplicate channel names)', () => {
    const unique = new Set(allValues)
    expect(unique.size).toBe(allValues.length)
  })

  it('all values are non-empty strings', () => {
    for (const val of allValues) {
      expect(typeof val).toBe('string')
      expect(val.length).toBeGreaterThan(0)
    }
  })

  it('all values follow the "namespace:action" convention', () => {
    for (const val of allValues) {
      expect(val).toMatch(/^[a-z]+:[a-z]/)
    }
  })

  it('has expected namespace groups', () => {
    const namespaces = new Set(allValues.map(v => v.split(':')[0]))
    expect(namespaces).toContain('auth')
    expect(namespaces).toContain('agent')
    expect(namespaces).toContain('fs')
    expect(namespaces).toContain('term')
    expect(namespaces).toContain('dialog')
    expect(namespaces).toContain('cli')
  })

  it('has at least 30 channels', () => {
    expect(allValues.length).toBeGreaterThanOrEqual(30)
  })

  // Verify critical channels exist
  const criticalChannels = [
    'AGENT_START', 'AGENT_SEND', 'AGENT_STOP',
    'AUTH_LOGIN', 'AUTH_STATUS',
    'FS_READ_DIR', 'FS_READ_FILE',
    'TERM_CREATE', 'TERM_WRITE',
  ]
  for (const key of criticalChannels) {
    it(`has critical channel: ${key}`, () => {
      expect(IPC[key as keyof typeof IPC]).toBeDefined()
    })
  }
})
