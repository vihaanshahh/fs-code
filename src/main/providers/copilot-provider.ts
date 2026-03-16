/**
 * GitHub Copilot provider — uses the `copilot` CLI.
 * npm: @github/copilot, binary: copilot
 */

import { randomUUID } from 'node:crypto'
import { JsonlProvider } from './jsonl-provider'
import type { UIMessage } from '../../shared/types'

function uid(): string {
  return randomUUID().slice(0, 8)
}

export function createCopilotProvider(): JsonlProvider {
  return new JsonlProvider({
    id: 'copilot',
    displayName: 'GitHub Copilot',
    binary: 'copilot',
    buildArgs(prompt, _options, _model) {
      return ['-p', prompt, '--output', 'json']
    },
    buildEnv() {
      return {}
    },
    parseEvent(event: Record<string, unknown>): UIMessage[] {
      const out: UIMessage[] = []
      const type = event.type as string

      if (type === 'content' || type === 'message' || type === 'text') {
        const text = (event.text || event.content || event.message || '') as string
        if (text) {
          out.push({ id: uid(), type: 'assistant', text, isStreaming: false, ts: Date.now() })
        }
      } else if (type === 'delta' || type === 'partial') {
        const text = (event.text || event.delta || '') as string
        if (text) {
          out.push({ id: uid(), type: 'assistant', text, isStreaming: true, ts: Date.now() })
        }
      } else if (type === 'suggestion') {
        const text = (event.text || event.suggestion || '') as string
        if (text) {
          out.push({ id: uid(), type: 'assistant', text, isStreaming: false, ts: Date.now() })
        }
      } else if (type === 'error') {
        out.push({ id: uid(), type: 'error', message: (event.message || event.error || 'Unknown error') as string, ts: Date.now() })
      } else if (type === 'done' || type === 'complete') {
        out.push({ id: uid(), type: 'result', cost: 0, duration: 0, numTurns: 1, ts: Date.now() })
      }

      return out
    },
    models: [
      { value: 'copilot', displayName: 'Copilot', description: 'GitHub Copilot default model' },
    ],
    defaultModel: 'copilot',
  })
}
