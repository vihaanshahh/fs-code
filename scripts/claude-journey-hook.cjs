#!/usr/bin/env node

const fs = require('node:fs')

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.resume()
  })
}

function basename(filePath) {
  if (!filePath || typeof filePath !== 'string') return ''
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

function toolToPhase(toolName, toolInput, toolUseId) {
  const command = typeof toolInput?.command === 'string' ? toolInput.command : ''
  const fileName = basename(toolInput?.file_path || toolInput?.path || '')
  const activeTool = toolUseId ? {
    toolUseId,
    toolName,
    startTs: Date.now(),
    elapsed: 0,
  } : undefined

  if (toolName === 'AskUserQuestion') return { phase: 'awaiting', detail: 'Needs attention', activeTool }
  if (/^(WebSearch|WebFetch|Agent|Skill)$/i.test(toolName)) return { phase: 'searching', detail: 'Researching...', activeTool }
  if (/^(Grep|Glob|Search|ListFiles)$/i.test(toolName)) return { phase: 'searching', detail: 'Searching...', activeTool }
  if (/^(Read|Ls)$/i.test(toolName)) return { phase: 'searching', detail: fileName ? `Reading ${fileName}` : 'Reading files...', activeTool }
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/i.test(toolName)) return { phase: 'coding', detail: fileName ? `Editing ${fileName}` : 'Writing code...', activeTool }
  if (/^Bash$/i.test(toolName)) {
    if (/\b(test|jest|vitest|mocha|pytest|cargo test|go test|npm test|bun test|yarn test|make test|build|tsc|eslint|lint)\b/i.test(command)) {
      return { phase: 'testing', detail: 'Running checks...', activeTool }
    }
    if (/\b(>|>>|tee|cp|mv|mkdir|touch)\b/.test(command)) {
      return { phase: 'coding', detail: 'Applying shell changes...', activeTool }
    }
    return { phase: 'thinking', detail: 'Running commands...', activeTool }
  }
  return { phase: 'thinking', detail: `Using ${toolName}...`, activeTool }
}

async function main() {
  const outFile = process.env.FLUIDSTATE_JOURNEY_FILE
  if (!outFile) return

  let input = {}
  try {
    const raw = await readStdin()
    input = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    input = {}
  }

  const hookEvent = input.hook_event_name || ''
  const toolName = input.tool_name || ''
  const toolInput = input.tool_input || {}
  const toolUseId = input.tool_use_id || ''

  let payload
  if (hookEvent === 'UserPromptSubmit') {
    // User submitted a message — Claude is about to start thinking
    payload = { phase: 'thinking', detail: 'Thinking...' }
  } else if (hookEvent === 'PreToolUse') {
    payload = toolToPhase(toolName, toolInput, toolUseId)
  } else if (hookEvent === 'PostToolUse') {
    // Tool finished — Claude is processing the result
    payload = { phase: 'thinking', detail: 'Thinking...' }
  } else if (hookEvent === 'PermissionRequest') {
    // Claude needs the user to approve a tool — authoritative awaiting signal
    payload = {
      phase: 'awaiting',
      detail: toolName ? `Allow ${toolName}?` : 'Needs attention',
    }
  } else if (hookEvent === 'Stop') {
    // Claude finished its turn and returned to the input prompt — authoritative done signal.
    // This fires even after interrupts and permission denials, closing any stale coding/thinking state.
    payload = { phase: 'done', detail: 'Completed' }
  } else {
    // SessionStart and everything else: emit nothing
    return
  }

  fs.appendFileSync(outFile, JSON.stringify({
    ts: Date.now(),
    ...payload,
  }) + '\n')
}

main().catch(() => {
  process.exitCode = 0
})
