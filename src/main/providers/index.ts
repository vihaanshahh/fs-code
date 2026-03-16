/**
 * Provider factory and detection.
 * Creates the right ProviderDriver for a given ProviderId.
 */

import type { ProviderId } from '../../shared/types'
import type { ProviderDriver } from './provider'
import { ClaudeProvider } from './claude-provider'
import { createOpenAIProvider } from './openai-provider'
import { createGeminiProvider } from './gemini-provider'
import { createCopilotProvider } from './copilot-provider'

/** API key getter — injected from the keystore */
let apiKeyGetter: (provider: ProviderId) => string | null = () => null

export function setApiKeyGetter(getter: (provider: ProviderId) => string | null): void {
  apiKeyGetter = getter
}

/** Create a provider driver for the given provider ID */
export function createProvider(id: ProviderId): ProviderDriver {
  switch (id) {
    case 'claude':
      return new ClaudeProvider()
    case 'openai':
      return createOpenAIProvider(() => apiKeyGetter('openai'))
    case 'gemini':
      return createGeminiProvider(() => apiKeyGetter('gemini'))
    case 'copilot':
      return createCopilotProvider()
    default:
      throw new Error(`Unknown provider: ${id}`)
  }
}

/** Detect which providers are available on this system */
export async function detectProviders(): Promise<Record<ProviderId, { available: boolean; error?: string }>> {
  const providers: ProviderId[] = ['claude', 'copilot', 'openai', 'gemini']
  const results: Record<string, { available: boolean; error?: string }> = {}

  await Promise.all(
    providers.map(async (id) => {
      try {
        const driver = createProvider(id)
        const error = await driver.checkAvailability()
        driver.dispose()
        results[id] = { available: error === null, error: error || undefined }
      } catch (err: any) {
        results[id] = { available: false, error: err.message }
      }
    })
  )

  return results as Record<ProviderId, { available: boolean; error?: string }>
}

// Re-export types
export type { ProviderDriver, ProviderHandle, ModelInfo, PermissionHandler, SendPromptOptions } from './provider'
export { ClaudeProvider } from './claude-provider'
