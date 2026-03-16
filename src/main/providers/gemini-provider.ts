/**
 * Google Gemini CLI provider — uses the `gemini` CLI in streaming JSON mode.
 * npm: @google/gemini-cli, binary: gemini
 */

import { randomUUID } from 'node:crypto'
import { JsonlProvider } from './jsonl-provider'
import type { UIMessage } from '../../shared/types'

function uid(): string {
  return randomUUID().slice(0, 8)
}

export function createGeminiProvider(getApiKey: () => string | null): JsonlProvider {
  return new JsonlProvider({
    id: 'gemini',
    displayName: 'Google Gemini',
    binary: 'gemini',
    buildArgs(prompt, _options, model) {
      const args = ['-p', prompt, '--output-format', 'stream-json']
      if (model && model !== 'gemini-2.5-pro') args.push('--model', model)
      return args
    },
    buildEnv() {
      const env: Record<string, string> = {}
      const key = getApiKey()
      if (key) env.GEMINI_API_KEY = key
      return env
    },
    parseEvent(event: Record<string, unknown>): UIMessage[] {
      const out: UIMessage[] = []
      const type = event.type as string

      if (type === 'text' || type === 'content') {
        const text = (event.text || event.content || '') as string
        if (text) {
          out.push({ id: uid(), type: 'assistant', text, isStreaming: false, ts: Date.now() })
        }
      } else if (type === 'partial') {
        const text = (event.text || '') as string
        if (text) {
          out.push({ id: uid(), type: 'assistant', text, isStreaming: true, ts: Date.now() })
        }
      } else if (type === 'tool_call') {
        out.push({
          id: uid(),
          type: 'tool-use',
          toolName: (event.name || 'tool') as string,
          toolUseId: (event.id || uid()) as string,
          input: (event.args || event.input || {}) as unknown,
          ts: Date.now(),
        })
      } else if (type === 'error') {
        out.push({ id: uid(), type: 'error', message: (event.message || event.error || 'Unknown error') as string, ts: Date.now() })
      } else if (type === 'done' || type === 'result') {
        out.push({ id: uid(), type: 'result', cost: 0, duration: 0, numTurns: 1, ts: Date.now() })
      }

      return out
    },
    models: [
      { value: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', description: 'Most capable Gemini model' },
      { value: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', description: 'Fast and efficient' },
    ],
    defaultModel: 'gemini-2.5-pro',
  })
}
