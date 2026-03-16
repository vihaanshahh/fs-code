/**
 * Generic JSONL CLI provider — spawns a CLI binary, reads JSONL from stdout,
 * and maps events to UIMessage[] via a configurable parser.
 * Used as the base for OpenAI Codex and Gemini providers.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
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
  /** Build args array from the prompt and options */
  buildArgs(prompt: string, options: SendPromptOptions): string[]
  /** Extra env vars to inject (e.g. API keys) */
  buildEnv(): Record<string, string>
  /** Parse a JSON event object into UIMessages */
  parseEvent(event: Record<string, unknown>): UIMessage[]
  /** Available models (static or fetched) */
  models: ModelInfo[]
  /** Default model */
  defaultModel: string
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
    // Check if the binary exists on PATH
    const which = isWindows ? 'where' : 'which'
    return new Promise((resolve) => {
      const proc = spawn(which, [this.config.binary], { stdio: 'pipe' })
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

    const args = this.config.buildArgs(prompt, options)
    const env = {
      ...process.env,
      ...this.config.buildEnv(),
    }

    onStart()
    onMessage({ id: uid(), type: 'system', text: `Connected \u00b7 ${this.displayName}`, ts: Date.now() })

    const child = spawn(this.config.binary, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows,
    })
    this.child = child

    let buffer = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          const msgs = this.config.parseEvent(event)
          for (const m of msgs) onMessage(m)
        } catch {
          // Not JSON — treat as plain text output
          if (trimmed) {
            // Accumulate as streaming text
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
      }
    })

    child.on('close', (code) => {
      // Flush any remaining streaming text
      if (this.streamingText && this.streamingId) {
        onMessage({ id: this.streamingId, type: 'assistant', text: this.streamingText, isStreaming: false, ts: Date.now() })
        this.streamingText = ''
        this.streamingId = ''
      }

      if (code !== 0 && code !== null) {
        onMessage({ id: uid(), type: 'error', message: `${this.config.binary} exited with code ${code}`, ts: Date.now() })
      }

      onMessage({ id: uid(), type: 'result', cost: 0, duration: 0, numTurns: 1, ts: Date.now() })
      this.child = null
      onEnd()
    })

    child.on('error', (err) => {
      onMessage({ id: uid(), type: 'error', message: `Failed to start ${this.config.binary}: ${err.message}`, ts: Date.now() })
      this.child = null
      onEnd()
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
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM')
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
