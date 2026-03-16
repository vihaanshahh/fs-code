/**
 * OpenAI Codex provider — uses the `codex` CLI in JSONL mode.
 */

import { randomUUID } from 'node:crypto'
import { JsonlProvider } from './jsonl-provider'
import type { UIMessage } from '../../shared/types'
import type { ModelInfo } from './provider'

function uid(): string {
  return randomUUID().slice(0, 8)
}

export function createOpenAIProvider(getApiKey: () => string | null): JsonlProvider {
  return new JsonlProvider({
    id: 'openai',
    displayName: 'OpenAI Codex',
    binary: 'codex',
    buildArgs(prompt) {
      return ['exec', '--json', prompt]
    },
    buildEnv() {
      const env: Record<string, string> = {}
      const key = getApiKey()
      if (key) env.OPENAI_API_KEY = key
      return env
    },
    parseEvent(event: Record<string, unknown>): UIMessage[] {
      const out: UIMessage[] = []
      const type = event.type as string

      if (type === 'message' || type === 'text') {
        const text = (event.text || event.content || event.message || '') as string
        if (text) {
          out.push({ id: uid(), type: 'assistant', text, isStreaming: false, ts: Date.now() })
        }
      } else if (type === 'tool_call' || type === 'function_call') {
        out.push({
          id: uid(),
          type: 'tool-use',
          toolName: (event.name || event.tool || 'tool') as string,
          toolUseId: (event.id || uid()) as string,
          input: (event.arguments || event.input || {}) as unknown,
          ts: Date.now(),
        })
      } else if (type === 'error') {
        out.push({ id: uid(), type: 'error', message: (event.message || event.error || 'Unknown error') as string, ts: Date.now() })
      } else if (type === 'done' || type === 'complete') {
        out.push({ id: uid(), type: 'result', cost: 0, duration: 0, numTurns: 1, ts: Date.now() })
      }

      return out
    },
    models: [
      { value: 'codex-mini', displayName: 'Codex Mini', description: 'Fast, lightweight model' },
      { value: 'o3', displayName: 'O3', description: 'Advanced reasoning model' },
      { value: 'o4-mini', displayName: 'O4 Mini', description: 'Latest compact model' },
    ],
    defaultModel: 'codex-mini',
  })
}
