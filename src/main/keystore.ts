/**
 * Encrypted API key storage using Electron's safeStorage.
 * Keys are encrypted at rest and stored to userData/provider-keys.enc.
 */

import { safeStorage, app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import type { ProviderId } from '../shared/types'

const STORE_FILE = 'provider-keys.enc'

interface KeyStore {
  [provider: string]: string // base64-encoded encrypted value
}

function getStorePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

function loadStore(): KeyStore {
  const path = getStorePath()
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function saveStore(store: KeyStore): void {
  const path = getStorePath()
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

/** Store an API key (encrypted) for a provider */
export function setApiKey(provider: ProviderId, key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[keystore] Encryption not available — storing key in plaintext')
    const store = loadStore()
    store[provider] = Buffer.from(key).toString('base64')
    saveStore(store)
    return
  }

  const encrypted = safeStorage.encryptString(key)
  const store = loadStore()
  store[provider] = encrypted.toString('base64')
  saveStore(store)
}

/** Retrieve an API key for a provider (decrypted) */
export function getApiKey(provider: ProviderId): string | null {
  const store = loadStore()
  const encoded = store[provider]
  if (!encoded) return null

  try {
    const buffer = Buffer.from(encoded, 'base64')
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: stored as plain base64
      return buffer.toString('utf-8')
    }
    return safeStorage.decryptString(buffer)
  } catch (err) {
    console.error(`[keystore] Failed to decrypt key for ${provider}:`, err)
    return null
  }
}

/** Remove an API key for a provider */
export function removeApiKey(provider: ProviderId): void {
  const store = loadStore()
  delete store[provider]
  saveStore(store)
}

/** Check if an API key exists for a provider */
export function hasApiKey(provider: ProviderId): boolean {
  const store = loadStore()
  return !!store[provider]
}
