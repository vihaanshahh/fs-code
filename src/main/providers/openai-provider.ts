/**
 * OpenAI Codex provider — uses the `codex` CLI in JSONL mode.
 * npm: @openai/codex, binary: codex
 *
 * Event format (codex-cli 0.1xx+):
 *   { type: "thread.started", thread_id }
 *   { type: "turn.started" }
 *   { type: "item.started",   item: { id, type: "command_execution", command, status: "in_progress" } }
 *   { type: "item.completed", item: { id, type: "agent_message", text } }
 *   { type: "item.completed", item: { id, type: "command_execution", command, aggregated_output, exit_code, status } }
 *   { type: "turn.completed", usage: { input_tokens, cached_input_tokens, output_tokens } }
 */

import { randomUUID } from 'node:crypto'
import { JsonlProvider } from './jsonl-provider'
import type { UIMessage } from '../../shared/types'

function uid(): string {
  return randomUUID().slice(0, 8)
}

export function createOpenAIProvider(getApiKey: () => string | null): JsonlProvider {
  // Track in-progress command executions so we can emit tool-result on completion
  const pendingTools = new Map<string, string>() // item.id → toolUseId

  return new JsonlProvider({
    id: 'openai',
    displayName: 'OpenAI Codex',
    binary: 'codex',
    buildArgs(prompt, _options, model) {
      const args = ['exec', '--json']
      if (model && model !== 'codex-mini') args.push('--model', model)
      args.push(prompt)
      return args
    },
    buildEnv() {
      const env: Record<string, string> = {}
      const key = getApiKey()
      if (key) env.OPENAI_API_KEY = key
      return env
    },
    parseEvent(event: Record<string, unknown>): UIMessage[] {
      const out: UIMessage[] = []
      const type = (event.type ?? '') as string
      const item = event.item as Record<string, unknown> | undefined

      // --- codex-cli event format ---

      if (type === 'item.completed' && item) {
        const itemType = item.type as string

        if (itemType === 'agent_message') {
          const text = (item.text || '') as string
          if (text) {
            out.push({ id: uid(), type: 'assistant', text, isStreaming: false, ts: Date.now() })
          }
        } else if (itemType === 'command_execution') {
          const itemId = (item.id || '') as string
          const command = (item.command || '') as string
          const output = (item.aggregated_output || '') as string
          const exitCode = item.exit_code as number | null

          // Emit tool-result for the previously started tool
          const existingToolId = pendingTools.get(itemId)
          if (existingToolId) {
            out.push({
              id: uid(),
              type: 'tool-result',
              toolUseId: existingToolId,
              output: output.slice(0, 2000), // cap output for UI
              ts: Date.now(),
            })
            pendingTools.delete(itemId)
          } else {
            // No matching item.started — emit both tool-use and tool-result
            const toolUseId = uid()
            out.push({
              id: uid(),
              type: 'tool-use',
              toolName: 'Bash',
              toolUseId,
              input: { command },
              ts: Date.now(),
            })
            out.push({
              id: uid(),
              type: 'tool-result',
              toolUseId,
              output: output.slice(0, 2000),
              ts: Date.now(),
            })
          }

          if (exitCode !== null && exitCode !== 0) {
            out.push({ id: uid(), type: 'error', message: `Command exited with code ${exitCode}`, ts: Date.now() })
          }
        }
      } else if (type === 'item.started' && item) {
        const itemType = item.type as string
        if (itemType === 'command_execution') {
          const toolUseId = uid()
          const itemId = (item.id || '') as string
          pendingTools.set(itemId, toolUseId)
          out.push({
            id: uid(),
            type: 'tool-use',
            toolName: 'Bash',
            toolUseId,
            input: { command: (item.command || '') as string },
            ts: Date.now(),
          })
        }
      } else if (type === 'turn.completed') {
        const usage = event.usage as Record<string, number> | undefined
        const inputTokens = usage?.input_tokens ?? 0
        const outputTokens = usage?.output_tokens ?? 0
        out.push({
          id: uid(),
          type: 'result',
          cost: 0,
          duration: 0,
          numTurns: 1,
          ts: Date.now(),
          inputTokens,
          outputTokens,
        } as UIMessage)
      } else if (type === 'error') {
        out.push({ id: uid(), type: 'error', message: (event.message || event.error || 'Unknown error') as string, ts: Date.now() })
      }

      // thread.started, turn.started → metadata, skip silently

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
