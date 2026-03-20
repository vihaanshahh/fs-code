/**
 * Generic JSONL CLI provider — spawns a CLI binary, reads JSONL from stdout,
 * and maps events to UIMessage[] via a configurable parser.
 * Used as the base for OpenAI Codex, Gemini, and Copilot providers.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { buildCleanEnv } from '../agent-env'
import type { ProviderDriver, ProviderHandle, ModelInfo, PermissionHandler, SendPromptOptions } from './provider'
import type { UIMessage, PermissionMode } from '../../shared/types'

const isWindows = platform() === 'win32'

function uid(): string {
  return randomUUID().slice(0, 8)
}

/** Configuration for a JSONL-based CLI provider */
export interface JsonlProviderConfig {
  id: string
  displayName: string
  /** CLI binary name (resolved via PATH) */
  binary: string
  /** Build args array from the prompt, options, and current model */
  buildArgs(prompt: string, options: SendPromptOptions, model: string): string[]
  /** Extra env vars to inject (e.g. API keys) */
  buildEnv(): Record<string, string>
  /** Parse a JSON event object into UIMessages */
  parseEvent(event: Record<string, unknown>): UIMessage[]
  /** Available models (static or fetched) */
  models: ModelInfo[]
  /** Default model */
  defaultModel: string
}

/**
 * Try to extract meaningful text from an arbitrary JSON object.
 * CLIs output wildly different schemas — this covers common patterns:
 *   { content: "..." }, { message: { content: "..." } }, { text: "..." },
 *   { output: "..." }, { response: "..." }, { data: { text: "..." } },
 *   { candidates: [{ content: { parts: [{ text: "..." }] } }] }  (Gemini REST)
 */
export function extractTextFromJson(obj: Record<string, unknown>): string | null {
  // Direct string fields
  for (const key of ['text', 'content', 'output', 'response', 'answer', 'result', 'delta']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string
  }

  // message.content (OpenAI chat format)
  if (typeof obj.message === 'object' && obj.message !== null) {
    const msg = obj.message as Record<string, unknown>
    if (typeof msg.content === 'string' && msg.content) return msg.content
    if (typeof msg.text === 'string' && msg.text) return msg.text
  }

  // choices[].message.content or choices[].delta.content (OpenAI streaming)
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0] as Record<string, unknown>
    for (const field of ['message', 'delta']) {
      if (typeof choice[field] === 'object' && choice[field] !== null) {
        const inner = choice[field] as Record<string, unknown>
        if (typeof inner.content === 'string' && inner.content) return inner.content
      }
    }
    if (typeof choice.text === 'string' && choice.text) return choice.text
  }

  // candidates[].content.parts[].text (Gemini)
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const cand = obj.candidates[0] as Record<string, unknown>
    if (typeof cand.content === 'object' && cand.content !== null) {
      const content = cand.content as Record<string, unknown>
      if (Array.isArray(content.parts) && content.parts.length > 0) {
        const part = content.parts[0] as Record<string, unknown>
        if (typeof part.text === 'string' && part.text) return part.text
      }
    }
  }

  // data.text / data.content wrapper
  if (typeof obj.data === 'object' && obj.data !== null) {
    const data = obj.data as Record<string, unknown>
    if (typeof data.text === 'string' && data.text) return data.text
    if (typeof data.content === 'string' && data.content) return data.content
  }

  return null
}

export class JsonlProvider implements ProviderDriver {
  readonly id: string
  readonly displayName: string

  private config: JsonlProviderConfig
  private child: ChildProcess | null = null
  private currentModel: string
  private permissionHandler: PermissionHandler | null = null
  private streamingText = ''
  private streamingId = ''

  constructor(config: JsonlProviderConfig) {
    this.config = config
    this.id = config.id
    this.displayName = config.displayName
    this.currentModel = config.defaultModel
  }

  async checkAvailability(): Promise<string | null> {
    const which = isWindows ? 'where' : 'which'
    return new Promise((resolve) => {
      const proc = spawn(which, [this.config.binary], {
        stdio: 'pipe',
        timeout: 5000,
        shell: isWindows,
      })
      let found = false
      proc.stdout?.on('data', () => { found = true })
      proc.on('close', (code) => {
        resolve(found && code === 0 ? null : `${this.config.binary} CLI not found. Install it first.`)
      })
      proc.on('error', () => {
        resolve(`${this.config.binary} CLI not found. Install it first.`)
      })
    })
  }

  async validatePreflight(cwd: string): Promise<string[]> {
    const errors: string[] = []

    const avail = await this.checkAvailability()
    if (avail) {
      errors.push(avail)
      return errors
    }

    if (!existsSync(cwd)) {
      errors.push(`Working directory not found: ${cwd}`)
    }

    return errors
  }

  async sendPrompt(
    prompt: string,
    cwd: string,
    options: SendPromptOptions,
    onMessage: (msg: UIMessage) => void,
    onStart: () => void,
    onEnd: () => void,
  ): Promise<ProviderHandle> {
    this.stop()

    // Reset streaming state from any previous invocation
    this.streamingText = ''
    this.streamingId = ''

    const args = this.config.buildArgs(prompt, options, this.currentModel)

    // Use sanitized env to avoid leaking NODE_OPTIONS, ELECTRON_* etc.
    const cleanEnv = buildCleanEnv()
    const env = {
      ...cleanEnv,
      ...this.config.buildEnv(),
    }

    const child = spawn(this.config.binary, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows,
    })
    this.child = child

    // Close stdin — we don't write to it, and some CLIs hang waiting for input
    child.stdin?.end()

    // Only fire onStart after successful spawn
    let endCalled = false
    const safeOnEnd = () => {
      if (endCalled) return
      endCalled = true
      onEnd()
    }

    child.on('spawn', () => {
      onStart()
      onMessage({ id: uid(), type: 'system', text: `Connected \u00b7 ${this.displayName}`, ts: Date.now() })
    })

    let buffer = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '').trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          const msgs = this.config.parseEvent(event)
          if (msgs.length > 0) {
            for (const m of msgs) onMessage(m)
          } else {
            // parseEvent didn't recognize this JSON — try to extract text generically
            const fallbackText = extractTextFromJson(event)
            if (fallbackText) {
              this.streamingText += (this.streamingText ? '\n' : '') + fallbackText
              if (!this.streamingId) this.streamingId = uid()
              onMessage({ id: this.streamingId, type: 'assistant', text: this.streamingText, isStreaming: true, ts: Date.now() })
            }
            // If no text could be extracted, silently skip (status/metadata events)
          }
        } catch {
          // Not JSON — treat as plain text output
          if (trimmed) {
            this.streamingText += (this.streamingText ? '\n' : '') + trimmed
            if (!this.streamingId) this.streamingId = uid()
            onMessage({ id: this.streamingId, type: 'assistant', text: this.streamingText, isStreaming: true, ts: Date.now() })
          }
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) {
        console.error(`[${this.id}] stderr:`, text)
        // Surface stderr to user so they see auth errors, rate limits, etc.
        onMessage({ id: uid(), type: 'error', message: text, ts: Date.now() })
      }
    })

    child.on('close', (code) => {
      // Flush remaining buffer (last line without trailing newline)
      if (buffer.trim()) {
        const trimmed = buffer.replace(/\r$/, '').trim()
        try {
          const event = JSON.parse(trimmed)
          const msgs = this.config.parseEvent(event)
          if (msgs.length > 0) {
            for (const m of msgs) onMessage(m)
          } else {
            const fallbackText = extractTextFromJson(event)
            if (fallbackText) {
              this.streamingText += (this.streamingText ? '\n' : '') + fallbackText
            }
          }
        } catch {
          if (trimmed) {
            this.streamingText += (this.streamingText ? '\n' : '') + trimmed
          }
        }
        buffer = ''
      }

      // Flush any remaining streaming text
      if (this.streamingText && this.streamingId) {
        onMessage({ id: this.streamingId, type: 'assistant', text: this.streamingText, isStreaming: false, ts: Date.now() })
      }
      this.streamingText = ''
      this.streamingId = ''

      if (code !== 0 && code !== null) {
        onMessage({ id: uid(), type: 'error', message: `${this.config.binary} exited with code ${code}`, ts: Date.now() })
      }

      onMessage({ id: uid(), type: 'result', cost: 0, duration: 0, numTurns: 1, ts: Date.now() })
      this.child = null
      safeOnEnd()
    })

    child.on('error', (err) => {
      onMessage({ id: uid(), type: 'error', message: `Failed to start ${this.config.binary}: ${err.message}`, ts: Date.now() })
      this.streamingText = ''
      this.streamingId = ''
      this.child = null
      safeOnEnd()
    })

    return {
      close: () => {
        if (child && !child.killed) {
          child.kill('SIGTERM')
        }
        this.child = null
      },
      isRunning: () => this.child === child && !child.killed,
    }
  }

  stop(): void {
    const child = this.child
    if (child && !child.killed) {
      child.kill('SIGTERM')
      // Escalate to SIGKILL if process doesn't exit within 3s
      const killTimer = setTimeout(() => {
        if (!child.killed) {
          try { child.kill('SIGKILL') } catch { /* already dead */ }
        }
      }, 3000)
      child.once('exit', () => clearTimeout(killTimer))
    }
    this.child = null
  }

  async getModels(): Promise<ModelInfo[]> {
    return this.config.models
  }

  setModel(model: string): void {
    this.currentModel = model
  }

  getCurrentModel(): string {
    return this.currentModel
  }

  setPermissionMode(_mode: PermissionMode): void {
    // JSONL providers don't support permission modes
  }

  setPermissionHandler(handler: PermissionHandler): void {
    this.permissionHandler = handler
  }

  dispose(): void {
    this.stop()
  }
}
