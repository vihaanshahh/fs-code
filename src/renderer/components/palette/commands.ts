import type { SlashCommand, KeyboardShortcut } from '../../../shared/types'

export const slashCommands: SlashCommand[] = [
  // === Session ===
  { command: '/help', description: 'Show available commands', category: 'session' },
  { command: '/clear', description: 'Clear conversation history', category: 'session', aliases: ['/reset'] },
  { command: '/compact', description: 'Compact conversation to save context', category: 'session' },
  { command: '/cost', description: 'Show token usage and cost', category: 'session' },
  { command: '/usage', description: 'Show tokens, cost, and rate limit status', category: 'session' },
  { command: '/context', description: 'Show context window usage', category: 'session' },
  { command: '/stats', description: 'Show session statistics', category: 'session' },
  { command: '/login', description: 'Sign in to Anthropic account', category: 'session' },
  { command: '/logout', description: 'Sign out from Anthropic account', category: 'session' },
  { command: '/status', description: 'Check auth and connection status', category: 'session' },
  { command: '/doctor', description: 'Run diagnostics (CLI, auth, agents)', category: 'session' },
  { command: '/exit', description: 'Exit the application', category: 'session', aliases: ['/quit'] },

  // === History ===
  { command: '/resume', description: 'Pick and resume a previous session', category: 'history' },
  { command: '/continue', description: 'Continue the most recent session', category: 'history' },
  { command: '/export', description: 'Export conversation to clipboard', category: 'history' },
  { command: '/copy', description: 'Copy last assistant response to clipboard', category: 'history' },
  { command: '/diff', description: 'Show uncommitted git changes', category: 'history' },
  { command: '/rename', description: 'Rename this agent (max 8 chars)', category: 'history' },
  { command: '/fork', description: 'Fork conversation at this point', category: 'history' },

  // === Agent ===
  { command: '/new', description: 'Add new agent', category: 'agent' },
  { command: '/close', description: 'Close this agent', category: 'agent' },
  { command: '/agents', description: 'List active agents', category: 'agent' },
  { command: '/plan', description: 'Plan mode — think without executing tools', category: 'agent' },
  { command: '/accept-edits', description: 'Auto-approve file edits, ask for rest', category: 'agent' },
  { command: '/default-mode', description: 'Default mode — prompt for dangerous ops', category: 'agent' },
  { command: '/yolo', description: 'Bypass all permissions (use with caution)', category: 'agent' },
  { command: '/permissions', description: 'View or change permission mode', category: 'agent' },
  { command: '/btw', description: 'Ask a quick side question', category: 'agent' },
  { command: '/skills', description: 'List available skills', category: 'agent' },

  // === View ===
  { command: '/terminal', description: 'Toggle terminal drawer', category: 'view' },
  { command: '/files', description: 'Toggle file activity sidebar', category: 'view' },
  { command: '/theme', description: 'Cycle through themes', category: 'view' },
  { command: '/minimize', description: 'Minimize agents to floating pill', category: 'view' },

  // === Config ===
  { command: '/config', description: 'Show available settings commands', category: 'config', aliases: ['/settings'] },
  { command: '/model', description: 'Select or change the AI model', category: 'config' },
  { command: '/memory', description: 'Edit CLAUDE.md memory files', category: 'config' },
  { command: '/init', description: 'Initialize project with CLAUDE.md', category: 'config' },
  { command: '/mcp', description: 'List MCP server connections', category: 'config' },
  { command: '/add-dir', description: 'Add a new working directory', category: 'config' },
  { command: '/keybindings', description: 'Show keyboard shortcuts', category: 'config' },
  { command: '/hooks', description: 'Show hooks configuration info', category: 'config' },

  // === Info ===
  { command: '/feedback', description: 'Submit feedback about Claude Code', category: 'info', aliases: ['/bug'] },
  { command: '/release-notes', description: 'Show CLI version and changelog link', category: 'info' },
  { command: '/pr-comments', description: 'Fetch comments from GitHub pull request', category: 'info' },
  { command: '/review', description: 'Ask agent to review code changes', category: 'info' },
  { command: '/security-review', description: 'Analyze changes for security vulnerabilities', category: 'info' },

  // === Misc ===
  { command: '/upgrade', description: 'Open billing page for plan upgrade', category: 'misc' },
  { command: '/install-github-app', description: 'Install Claude GitHub Actions app', category: 'misc' },
  { command: '/install-slack-app', description: 'Install Claude Slack app', category: 'misc' },
  { command: '/plugin', description: 'Manage Claude Code plugins', category: 'misc' },
  { command: '/reload-plugins', description: 'Reload all active plugins', category: 'misc' },
  { command: '/desktop', description: 'Continue session in desktop app', category: 'misc', aliases: ['/app'] },
  { command: '/chrome', description: 'Claude in Chrome', category: 'misc' },
  { command: '/mobile', description: 'Claude mobile app', category: 'misc', aliases: ['/ios', '/android'] },
  { command: '/remote-control', description: 'Remote control from claude.ai', category: 'misc', aliases: ['/rc'] },
  { command: '/stickers', description: 'Order Claude Code stickers', category: 'misc' },
  { command: '/passes', description: 'Share a free week of Claude Code', category: 'misc' },
  { command: '/fast', description: 'Toggle fast mode', category: 'session' },
  { command: '/scm', description: 'Toggle source control panel', category: 'view' },
  { command: '/vim', description: 'Toggle vim editing mode', category: 'view' },
  { command: '/statusline', description: 'Configure status line display', category: 'view' },
  { command: '/sandbox', description: 'Toggle sandbox mode', category: 'config' },
  { command: '/extra-usage', description: 'Configure extra usage for rate limits', category: 'config' },
  { command: '/privacy-settings', description: 'View and update privacy settings', category: 'config' },
  { command: '/remote-env', description: 'Configure default remote environment', category: 'config' },
  { command: '/terminal-setup', description: 'Configure terminal keybindings', category: 'config' },
  { command: '/tasks', description: 'List and manage background tasks', category: 'history' },
  { command: '/rewind', description: 'Rewind conversation to previous point', category: 'history', aliases: ['/checkpoint'] },
  { command: '/insights', description: 'Session analytics and stats', category: 'info' },
  { command: '/ide', description: 'IDE integrations info', category: 'misc' },
]

// Build alias lookup map: alias -> canonical command
const aliasMap: Record<string, string> = {}
for (const cmd of slashCommands) {
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      aliasMap[alias] = cmd.command
    }
  }
}

/** Resolve aliases to their canonical command */
export function resolveAlias(input: string): string {
  const parts = input.split(' ')
  const cmd = parts[0].toLowerCase()
  const canonical = aliasMap[cmd]
  if (canonical) {
    parts[0] = canonical
    return parts.join(' ')
  }
  return input
}

export const keyboardShortcuts: KeyboardShortcut[] = [
  { keys: 'Cmd+K', description: 'Open command palette', category: 'navigation' },
  { keys: 'Cmd+?', description: 'Show keyboard shortcuts', category: 'navigation' },
  { keys: 'Cmd+1-9', description: 'Focus agent 1-9', category: 'agent' },
  { keys: 'Cmd+N', description: 'New agent', category: 'agent' },
  { keys: 'Cmd+W', description: 'Close focused agent', category: 'agent' },
  { keys: 'Cmd+`', description: 'Toggle terminal', category: 'view' },
  { keys: 'Cmd+B', description: 'Toggle file sidebar', category: 'view' },
  { keys: 'Cmd+Shift+G', description: 'Toggle source control', category: 'view' },
  { keys: 'Cmd+Shift+M', description: 'Toggle minimized agents pill', category: 'view' },
  { keys: 'Cmd+Enter', description: 'Send message', category: 'navigation' },
  { keys: 'Escape', description: 'Close overlay / stop agent', category: 'navigation' },
]

interface PaletteCommand {
  id: string
  label: string
  description: string
  shortcut?: string
}

export const paletteCommands: PaletteCommand[] = [
  { id: 'new-agent', label: 'New Agent', description: 'Create a new agent instance', shortcut: 'Cmd+N' },
  { id: 'close-agent', label: 'Close Agent', description: 'Close the focused agent', shortcut: 'Cmd+W' },
  { id: 'toggle-terminal', label: 'Toggle Terminal', description: 'Show/hide terminal drawer', shortcut: 'Cmd+`' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', description: 'Show/hide file activity sidebar', shortcut: 'Cmd+B' },
  { id: 'clear', label: 'Clear Conversation', description: 'Clear focused agent messages' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', description: 'View all shortcuts', shortcut: 'Cmd+?' },
  { id: 'login', label: 'Log In', description: 'Log in to Claude (opens browser)' },
  { id: 'logout', label: 'Log Out', description: 'Log out of Claude' },
  { id: 'toggle-theme', label: 'Cycle Theme', description: 'Cycle to the next theme' },
  { id: 'resume', label: 'Resume Session', description: 'Pick and resume a previous conversation' },
  { id: 'continue', label: 'Continue Session', description: 'Continue the most recent session' },
  { id: 'compact', label: 'Compact Context', description: 'Compact conversation to save context' },
  { id: 'copy-last', label: 'Copy Last Response', description: 'Copy last Claude response to clipboard' },
  { id: 'export', label: 'Export Conversation', description: 'Export conversation as text' },
  { id: 'diff', label: 'Show Diff', description: 'Show uncommitted git changes' },
  { id: 'init', label: 'Init CLAUDE.md', description: 'Initialize project with CLAUDE.md guide' },
  { id: 'doctor', label: 'Run Diagnostics', description: 'Check CLI, auth, and agent status' },
  { id: 'add-dir', label: 'Add Directory', description: 'Add a new working directory' },
  { id: 'cost', label: 'Show Cost', description: 'Display token usage and cost' },
  { id: 'context', label: 'Context Usage', description: 'Show context window usage' },
  { id: 'mode-plan', label: 'Plan Mode', description: 'Think without executing tools' },
  { id: 'mode-accept-edits', label: 'Accept Edits', description: 'Auto-approve file edits' },
  { id: 'mode-default', label: 'Default Mode', description: 'Prompt for dangerous operations' },
  { id: 'mode-yolo', label: 'Bypass Permissions', description: 'Auto-approve everything (use with caution)' },
  { id: 'minimize', label: 'Minimize Agents', description: 'Collapse to floating pill', shortcut: 'Cmd+Shift+M' },
  { id: 'toggle-scm', label: 'Source Control', description: 'Toggle SCM panel', shortcut: 'Cmd+Shift+G' },
  { id: 'install-cli', label: "Install 'fluidstate' command in PATH", description: 'Run fluidstate from any terminal' },
]
