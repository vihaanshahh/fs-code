/**
 * Encrypted API key storage using Electron's safeStorage.
 * Keys are encrypted at rest and stored to userData/provider-keys.enc.
 */

import { safeStorage, app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import type { ProviderId } from '../shared/types'

const STORE_FILE = 'provider-keys.enc'

// Special key used for the GitHub token (private repo update auth)
const GH_TOKEN_KEY = '__github_token__'

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

// ── GitHub token (for private repo auto-update) ──

/** Store the GitHub personal access token (encrypted) */
export function setGitHubToken(token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    const store = loadStore()
    store[GH_TOKEN_KEY] = Buffer.from(token).toString('base64')
    saveStore(store)
    return
  }
  const encrypted = safeStorage.encryptString(token)
  const store = loadStore()
  store[GH_TOKEN_KEY] = encrypted.toString('base64')
  saveStore(store)
}

/** Retrieve the GitHub personal access token (decrypted) */
export function getGitHubToken(): string | null {
  const store = loadStore()
  const encoded = store[GH_TOKEN_KEY]
  if (!encoded) return null
  try {
    const buffer = Buffer.from(encoded, 'base64')
    if (!safeStorage.isEncryptionAvailable()) return buffer.toString('utf-8')
    return safeStorage.decryptString(buffer)
  } catch (err) {
    console.error('[keystore] Failed to decrypt GitHub token:', err)
    return null
  }
}

/** Check if a GitHub token is stored */
export function hasGitHubToken(): boolean {
  const store = loadStore()
  return !!store[GH_TOKEN_KEY]
}

/** Remove the GitHub token */
export function removeGitHubToken(): void {
  const store = loadStore()
  delete store[GH_TOKEN_KEY]
  saveStore(store)
}
