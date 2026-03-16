/**
 * Claude provider — wraps @anthropic-ai/claude-agent-sdk.
 * Extracted from agent.ts so agent.ts can delegate to any ProviderDriver.
 */

import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import type { Query, SDKMessage, PermissionResult, ModelInfo as SDKModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, accessSync } from 'node:fs'
import { platform } from 'node:os'
import { execFileSync } from 'node:child_process'
import { app } from 'electron'
import { getAuthStatus } from '../auth'
import { buildCleanEnv as _buildCleanEnv, getCliAccessFlag, getCliAccessError } from '../agent-env'
import type { ProviderDriver, ProviderHandle, ModelInfo, PermissionHandler, SendPromptOptions } from './provider'
import type { UIMessage, PermissionMode } from '../../shared/types'

const isWindows = platform() === 'win32'

function uid(): string {
  return randomUUID().slice(0, 8)
}

/** Cache the resolved CLI path so we only do the lookup once */
let cachedCliPath: string | null = null

/**
 * Resolve the Claude Code CLI path.
 * 1. Bundled SDK cli.js (inside packaged app)
 * 2. User-installed `claude` on PATH (fallback — covers Windows where ASAR unpack can fail)
 */
function getCliPath(): string {
  if (cachedCliPath) return cachedCliPath

  // 1. Try bundled SDK cli.js
  const sdkCliRel = join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js')
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'app.asar.unpacked', sdkCliRel)
    if (existsSync(bundled)) {
      cachedCliPath = bundled
      return bundled
    }
  } else {
    const devPath = join(app.getAppPath(), sdkCliRel)
    if (existsSync(devPath)) {
      cachedCliPath = devPath
      return devPath
    }
  }

  // 2. Fallback: find `claude` on PATH (user's own install)
  const systemCli = findClaudeOnPath()
  if (systemCli) {
    console.log(`[claude-provider] using system CLI: ${systemCli}`)
    cachedCliPath = systemCli
    return systemCli
  }

  // 3. Return the expected bundled path so error messages are useful
  const expected = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', sdkCliRel)
    : join(app.getAppPath(), sdkCliRel)
  return expected
}

/** Try to find `claude` on the user's system */
function findClaudeOnPath(): string | null {
  // 1. Try `where`/`which` first
  try {
    const cmd = isWindows ? 'where' : 'which'
    const result = execFileSync(cmd, ['claude'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    const first = result.split(/\r?\n/)[0]?.trim()
    if (first && existsSync(first)) return first
  } catch { /* not on PATH */ }

  // 2. On Windows, check common install locations that shells find but `where` misses
  if (isWindows) {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')

    const candidates = [
      // npm global install — the most common case
      join(appData, 'npm', 'claude.cmd'),
      join(appData, 'npm', 'claude'),
      // Claude's own installer
      join(localAppData, 'Programs', 'claude', 'claude.exe'),
      join(localAppData, 'claude', 'claude.exe'),
      // .claude local bin
      join(home, '.claude', 'local', 'claude.exe'),
      join(home, '.claude', 'bin', 'claude.exe'),
      // pnpm / yarn global
      join(localAppData, 'pnpm', 'claude.cmd'),
      join(localAppData, 'pnpm', 'claude'),
      // Scoop
      join(home, 'scoop', 'shims', 'claude.cmd'),
      join(home, 'scoop', 'shims', 'claude.exe'),
    ]

    for (const p of candidates) {
      if (existsSync(p)) {
        console.log(`[claude-provider] found CLI at known location: ${p}`)
        return p
      }
    }

    // 3. Last resort: ask npm where its global bin is
    try {
      const npmBin = execFileSync('npm', ['prefix', '-g'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      }).trim()
      if (npmBin) {
        const npmClaude = join(npmBin, 'claude.cmd')
        if (existsSync(npmClaude)) return npmClaude
        const npmClaude2 = join(npmBin, 'claude')
        if (existsSync(npmClaude2)) return npmClaude2
      }
    } catch { /* npm not available */ }
  }

  return null
}

function buildCleanEnv(): Record<string, string> {
  return _buildCleanEnv(process.env as Record<string, string | undefined>, isWindows)
}

export class ClaudeProvider implements ProviderDriver {
  readonly id = 'claude' as const
  readonly displayName = 'Claude'

  private activeQuery: Query | null = null
  private streamingText = ''
  private streamingId = ''
  private sdkSessionId: string | null = null
  private hasShownInit = false
  private currentModel = ''
  private permissionMode: PermissionMode = 'default'
  private permissionHandler: PermissionHandler | null = null

  async checkAvailability(): Promise<string | null> {
    const cliPath = getCliPath()
    if (!existsSync(cliPath)) {
      return `Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code`
    }
    try {
      accessSync(cliPath, getCliAccessFlag(isWindows))
    } catch {
      return getCliAccessError(cliPath, isWindows)
    }
    return null
  }

  async validatePreflight(cwd: string): Promise<string[]> {
    const errors: string[] = []

    const cliPath = getCliPath()
    if (!existsSync(cliPath)) {
      errors.push(
        'Claude Code CLI not found. '
        + (isWindows
          ? 'Make sure `claude` is installed and on your PATH (run `where claude` to check).'
          : 'Reinstall the app or run `npm install -g @anthropic-ai/claude-code`.')
      )
      return errors
    }

    try {
      accessSync(cliPath, getCliAccessFlag(isWindows))
    } catch {
      errors.push(getCliAccessError(cliPath, isWindows))
      return errors
    }

    if (!existsSync(cwd)) {
      errors.push(`Working directory not found: ${cwd}`)
      return errors
    }

    if (!this.hasShownInit) {
      try {
        const auth = await getAuthStatus()
        if (!auth.authenticated) {
          errors.push('Not authenticated \u2014 use /login or click Sign In in the status bar')
        }
      } catch { /* non-fatal */ }
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
    // Close existing query
    if (this.activeQuery) {
      this.activeQuery.close()
      this.activeQuery = null
    }

    const opts: Record<string, unknown> = {
      pathToClaudeCodeExecutable: getCliPath(),
      executable: process.execPath,
      env: buildCleanEnv(),
      cwd,
      includePartialMessages: true,
      permissionMode: this.permissionMode,
    }

    // Permission handler
    if (this.permissionHandler) {
      const handler = this.permissionHandler
      opts.canUseTool = async (toolName: string, input: Record<string, unknown>, toolOpts: any): Promise<PermissionResult> => {
        // Auto-approve SDK internal tools
        const autoApproveTools = ['ExitPlanMode', 'EnterPlanMode', 'ExitWorktree', 'EnterWorktree']
        if (autoApproveTools.includes(toolName)) {
          return { behavior: 'allow', updatedInput: input }
        }
        const result = await handler(toolName, input, {
          decisionReason: toolOpts.decisionReason,
          suggestions: toolOpts.suggestions as unknown[],
        })
        if (result.behavior === 'allow') {
          return {
            behavior: 'allow',
            updatedInput: result.updatedInput || input,
            ...(result.updatedPermissions ? { updatedPermissions: result.updatedPermissions as any } : {}),
          }
        }
        return { behavior: 'deny', message: result.message || 'User denied' }
      }
    }

    // Session resume logic
    if (options.resumeSessionId) {
      opts.resume = options.resumeSessionId
    } else if (options.continueSession) {
      opts.continue = true
    } else if (this.sdkSessionId) {
      opts.resume = this.sdkSessionId
    }

    // Merge extra options
    if (options.extraOptions) {
      Object.assign(opts, options.extraOptions)
    }

    const q = query({ prompt, options: opts as any })
    this.activeQuery = q

    onStart()

    // Process messages in background
    this.processMessages(q, onMessage, onEnd)

    return {
      close: () => {
        q.close()
        this.activeQuery = null
      },
      isRunning: () => this.activeQuery === q,
    }
  }

  private async processMessages(
    q: Query,
    onMessage: (msg: UIMessage) => void,
    onEnd: () => void,
  ): Promise<void> {
    try {
      for await (const msg of q) {
        if (this.activeQuery !== q) break
        const uiMsgs = this.parseSDKMessage(msg)
        for (const m of uiMsgs) onMessage(m)
      }
    } catch (err: any) {
      const message = err?.message || String(err) || 'Unknown error'
      const isAuth = /auth|unauthorized|401|not.?logged.?in|not.?authenticated|invalid.?token/i.test(message)

      if (/exited with code 1/i.test(message)) {
        const hints: string[] = []
        if (!existsSync(getCliPath())) hints.push('CLI binary not found')
        try {
          const auth = await getAuthStatus()
          if (!auth.authenticated) hints.push('Not authenticated \u2014 use /login')
        } catch { /* ignore */ }
        if (!hints.length) hints.push('Check app logs for details (View \u2192 Toggle Developer Tools)')
        onMessage({ id: uid(), type: 'error', message: `Claude Code crashed. ${hints.join('. ')}.`, ts: Date.now() })
      } else if (isAuth) {
        onMessage({ id: uid(), type: 'error', message: 'Not authenticated \u2014 use /login or click Sign In in the status bar', ts: Date.now() })
      } else {
        onMessage({ id: uid(), type: 'error', message, ts: Date.now() })
      }
    } finally {
      if (this.activeQuery === q) {
        this.activeQuery = null
      }
      onEnd()
    }
  }

  stop(): void {
    if (this.activeQuery) {
      this.activeQuery.close()
      this.activeQuery = null
    }
  }

  async getModels(): Promise<ModelInfo[]> {
    if (!this.activeQuery) return []
    try {
      const supported = await this.activeQuery.supportedModels()
      return supported.map(m => ({ value: m.value, displayName: m.displayName, description: m.description }))
    } catch {
      return []
    }
  }

  setModel(model: string): void {
    if (this.activeQuery) {
      this.activeQuery.setModel(model).catch(() => {})
    }
    this.currentModel = model
  }

  getCurrentModel(): string {
    return this.currentModel
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode
    if (this.activeQuery) {
      this.activeQuery.setPermissionMode(mode as any).catch(() => {})
    }
  }

  setPermissionHandler(handler: PermissionHandler): void {
    this.permissionHandler = handler
  }

  dispose(): void {
    this.stop()
  }

  /** Whether we've shown the init message — exposed for agent.ts to manage session state */
  get sessionShownInit(): boolean { return this.hasShownInit }
  set sessionShownInit(v: boolean) { this.hasShownInit = v }

  get sessionId(): string | null { return this.sdkSessionId }
  set sessionId(v: string | null) { this.sdkSessionId = v }

  /** Check if there's an active query (for descriptor.isActive) */
  get isQueryActive(): boolean { return this.activeQuery !== null }

  // --- SDK Message Parsing ---

  private parseSDKMessage(msg: SDKMessage): UIMessage[] {
    const out: UIMessage[] = []
    const debugTypes = new Set(['rate_limit_event', 'result', 'auth_status'])
    if (debugTypes.has(msg.type)) {
      console.log(`[SDK:${msg.type}]`, JSON.stringify(msg).slice(0, 800))
    }

    switch (msg.type) {
      case 'system': {
        const sys = msg as any
        if (sys.subtype === 'init') {
          if (sys.model) this.currentModel = sys.model
          if (!this.hasShownInit) {
            this.hasShownInit = true
            out.push({ id: uid(), type: 'system', text: `Connected \u00b7 ${sys.model}`, ts: Date.now() })
          }
        } else if (sys.subtype === 'status' && sys.status === 'compacting') {
          out.push({ id: uid(), type: 'system', text: 'Compacting context...', ts: Date.now() })
        } else if (sys.subtype === 'task_started') {
          out.push({ id: uid(), type: 'system', text: `Task: ${sys.description}`, ts: Date.now() })
        } else if (sys.subtype === 'task_notification') {
          out.push({ id: uid(), type: 'system', text: `Task ${sys.status}: ${sys.summary}`, ts: Date.now() })
        } else if (sys.subtype === 'local_command_output') {
          out.push({ id: uid(), type: 'system', text: sys.content || '', ts: Date.now() })
        }
        return out
      }

      case 'assistant': {
        const am = msg as any
        this.streamingText = ''
        this.streamingId = ''
        if (!am.message?.content) return out
        for (const block of am.message.content) {
          if (block.type === 'text') {
            out.push({ id: uid(), type: 'assistant', text: block.text, isStreaming: false, ts: Date.now() })
          } else if (block.type === 'tool_use') {
            out.push({ id: uid(), type: 'tool-use', toolName: block.name, toolUseId: block.id, input: block.input, ts: Date.now() })
          }
        }
        if (am.message?.usage) {
          const u = am.message.usage
          if (u.input_tokens || u.output_tokens) {
            out.push({ id: uid(), type: 'token-usage', inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, ts: Date.now() })
          }
        }
        return out
      }

      case 'stream_event': {
        const se = msg as any
        const event = se.event
        if (!event) return out

        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'text') {
            this.streamingId = uid()
            this.streamingText = event.content_block.text || ''
            out.push({ id: this.streamingId, type: 'assistant', text: this.streamingText, isStreaming: true, ts: Date.now() })
          } else if (event.content_block?.type === 'tool_use') {
            out.push({ id: uid(), type: 'tool-use', toolName: event.content_block.name, toolUseId: event.content_block.id, input: {}, ts: Date.now() })
          }
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          this.streamingText += event.delta.text
          out.push({ id: this.streamingId || uid(), type: 'assistant', text: this.streamingText, isStreaming: true, ts: Date.now() })
        } else if (event.type === 'message_stop' || event.type === 'content_block_stop') {
          if (this.streamingText && this.streamingId) {
            out.push({ id: this.streamingId, type: 'assistant', text: this.streamingText, isStreaming: false, ts: Date.now() })
            this.streamingText = ''
            this.streamingId = ''
          }
        }
        if (event.type === 'message_delta' && event.usage) {
          const u = event.usage
          out.push({ id: uid(), type: 'token-usage', inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, ts: Date.now() })
        }
        return out
      }

      case 'tool_progress': {
        const tp = msg as any
        out.push({ id: uid(), type: 'tool-progress', toolName: tp.tool_name, toolUseId: tp.tool_use_id, elapsed: tp.elapsed_time_seconds, ts: Date.now() })
        return out
      }

      case 'tool_use_summary': {
        const ts = msg as any
        out.push({ id: uid(), type: 'system', text: ts.summary, ts: Date.now() })
        return out
      }

      case 'result': {
        const r = msg as any
        if (r.session_id) {
          this.sdkSessionId = r.session_id
          console.log(`[claude-provider] captured SDK session: ${r.session_id}`)
        }
        if (r.is_error) {
          out.push({ id: uid(), type: 'error', message: r.errors?.join('\n') || r.result || 'Error', ts: Date.now() })
        } else {
          out.push({ id: uid(), type: 'result', cost: r.total_cost_usd || 0, duration: r.duration_ms || 0, numTurns: r.num_turns || 0, ts: Date.now() })
        }
        if (r.usage) {
          out.push({ id: uid(), type: 'token-usage', inputTokens: r.usage.input_tokens || 0, outputTokens: r.usage.output_tokens || 0, ts: Date.now() })
        }
        if (r.modelUsage) {
          for (const [, mu] of Object.entries(r.modelUsage)) {
            const m = mu as any
            if (m.contextWindow && m.inputTokens) {
              out.push({
                id: uid(),
                type: 'usage' as const,
                utilization: (m.inputTokens + m.outputTokens + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0)) / m.contextWindow,
                resetsAt: null,
                limitType: 'context_window',
                status: 'allowed',
                ts: Date.now(),
              })
              break
            }
          }
        }
        return out
      }

      case 'rate_limit_event': {
        const rl = msg as any
        const info = rl.rate_limit_info
        if (!info) return out
        if (info.status === 'rejected') {
          const resetsIn = info.resetsAt ? Math.max(0, Math.round((info.resetsAt * 1000 - Date.now()) / 60000)) : null
          out.push({ id: uid(), type: 'error', message: `Rate limited${resetsIn ? ` \u2014 resets in ${resetsIn}m` : ''}`, ts: Date.now() })
        }
        if (typeof info.utilization === 'number') {
          out.push({
            id: uid(),
            type: 'usage' as const,
            utilization: info.utilization,
            resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
            limitType: info.rateLimitType || 'unknown',
            status: info.status || 'allowed',
            ts: Date.now(),
          })
        }
        return out
      }

      case 'auth_status': {
        const a = msg as any
        if (a.error) out.push({ id: uid(), type: 'error', message: `Auth error: ${a.error}. Use /login to sign in.`, ts: Date.now() })
        else if (a.account?.email) out.push({ id: uid(), type: 'system', text: `Signed in as ${a.account.email}`, ts: Date.now() })
        return out
      }

      default:
        return out
    }
  }
}

// Re-export Claude SDK session helpers for agent.ts to use
export { listSessions, getSessionMessages }
