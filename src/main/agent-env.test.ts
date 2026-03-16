import { describe, it, expect } from 'vitest'
import { constants as fsConstants } from 'node:fs'
import { buildCleanEnv, getCliAccessFlag, getCliAccessError } from './agent-env'

// ---------------------------------------------------------------------------
// buildCleanEnv — Windows mode
// ---------------------------------------------------------------------------
describe('buildCleanEnv (Windows)', () => {
  // Simulates a typical Windows environment
  const windowsEnv: Record<string, string> = {
    // Windows-critical vars
    SYSTEMROOT: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS',
    USERPROFILE: 'C:\\Users\\TestUser',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\TestUser',
    USERNAME: 'TestUser',
    APPDATA: 'C:\\Users\\TestUser\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local',
    PROGRAMDATA: 'C:\\ProgramData',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    PROGRAMW6432: 'C:\\Program Files',
    COMMONPROGRAMFILES: 'C:\\Program Files\\Common Files',
    SYSTEMDRIVE: 'C:',
    NUMBER_OF_PROCESSORS: '8',
    PROCESSOR_ARCHITECTURE: 'AMD64',
    OS: 'Windows_NT',
    Path: 'C:\\Windows;C:\\Windows\\system32', // Note: lowercase "Path" — Windows style
    TEMP: 'C:\\Users\\TestUser\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\TestUser\\AppData\\Local\\Temp',
    LANG: 'en_US.UTF-8',
    // Anthropic / Claude vars
    ANTHROPIC_API_KEY: 'sk-ant-test-key',
    CLAUDE_SOME_SETTING: 'enabled',
    // Vars that MUST be blocked
    NODE_OPTIONS: '--max-old-space-size=4096',
    CLAUDECODE: '1',
    NODE_DEBUG: 'http',
    DEBUG: '*',
    ELECTRON_RUN_AS_NODE: '0',
    ELECTRON_SOME_FLAG: 'yes',
    // Unix-only vars that should NOT leak into Windows builds
    HOME: '/home/user',
    USER: 'user',
    SHELL: '/bin/bash',
    TMPDIR: '/tmp',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    DISPLAY: ':0',
    // XDG_ should NOT pass through on Windows
    XDG_DATA_HOME: '/home/user/.local/share',
    // Random junk var
    MY_CUSTOM_VAR: 'whatever',
  }

  it('passes through all Windows-critical variables', () => {
    const result = buildCleanEnv(windowsEnv, true)

    expect(result.SYSTEMROOT).toBe('C:\\Windows')
    expect(result.WINDIR).toBe('C:\\Windows')
    expect(result.COMSPEC).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(result.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD;.VBS;.JS')
    expect(result.USERPROFILE).toBe('C:\\Users\\TestUser')
    expect(result.HOMEDRIVE).toBe('C:')
    expect(result.HOMEPATH).toBe('\\Users\\TestUser')
    expect(result.USERNAME).toBe('TestUser')
    expect(result.APPDATA).toBe('C:\\Users\\TestUser\\AppData\\Roaming')
    expect(result.LOCALAPPDATA).toBe('C:\\Users\\TestUser\\AppData\\Local')
    expect(result.PROGRAMDATA).toBe('C:\\ProgramData')
    expect(result.PROGRAMFILES).toBe('C:\\Program Files')
    expect(result['PROGRAMFILES(X86)']).toBe('C:\\Program Files (x86)')
    expect(result.PROGRAMW6432).toBe('C:\\Program Files')
    expect(result.COMMONPROGRAMFILES).toBe('C:\\Program Files\\Common Files')
    expect(result.SYSTEMDRIVE).toBe('C:')
    expect(result.NUMBER_OF_PROCESSORS).toBe('8')
    expect(result.PROCESSOR_ARCHITECTURE).toBe('AMD64')
    expect(result.OS).toBe('Windows_NT')
  })

  it('passes through common cross-platform vars (PATH, LANG, TEMP, TMP)', () => {
    const result = buildCleanEnv(windowsEnv, true)

    // Windows uses "Path" not "PATH" — case-insensitive matching should catch it
    expect(result.Path).toBe('C:\\Windows;C:\\Windows\\system32')
    expect(result.TEMP).toBe('C:\\Users\\TestUser\\AppData\\Local\\Temp')
    expect(result.TMP).toBe('C:\\Users\\TestUser\\AppData\\Local\\Temp')
    expect(result.LANG).toBe('en_US.UTF-8')
  })

  it('handles case-insensitive env var names (e.g. "Path" vs "PATH")', () => {
    const env = { Path: 'C:\\Windows', path: undefined as unknown as string }
    const result = buildCleanEnv(env, true)
    // Should match "Path" even though the passthrough list says "PATH"
    expect(result.Path).toBe('C:\\Windows')
  })

  it('passes through ANTHROPIC_ and CLAUDE_ prefixed vars on Windows', () => {
    const result = buildCleanEnv(windowsEnv, true)
    expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-test-key')
    expect(result.CLAUDE_SOME_SETTING).toBe('enabled')
  })

  it('blocks dangerous env vars (case-insensitive)', () => {
    const result = buildCleanEnv(windowsEnv, true)
    expect(result.NODE_OPTIONS).toBeUndefined()
    expect(result.CLAUDECODE).toBeUndefined()
    expect(result.NODE_DEBUG).toBeUndefined()
    expect(result.DEBUG).toBeUndefined()
    expect(result.ELECTRON_SOME_FLAG).toBeUndefined()
  })

  it('blocks dangerous vars even with weird casing', () => {
    const env = {
      node_options: '--inspect',
      ClaudeCode: '1',
      Electron_Foo: 'bar',
      node_debug: 'yes',
      debug: 'true',
    }
    const result = buildCleanEnv(env, true)
    expect(result.node_options).toBeUndefined()
    expect(result.ClaudeCode).toBeUndefined()
    expect(result.Electron_Foo).toBeUndefined()
    expect(result.node_debug).toBeUndefined()
    expect(result.debug).toBeUndefined()
  })

  it('does NOT pass Unix-only vars on Windows', () => {
    const result = buildCleanEnv(windowsEnv, true)
    expect(result.HOME).toBeUndefined()
    expect(result.USER).toBeUndefined()
    expect(result.SHELL).toBeUndefined()
    expect(result.TMPDIR).toBeUndefined()
    expect(result.SSH_AUTH_SOCK).toBeUndefined()
    expect(result.DISPLAY).toBeUndefined()
  })

  it('does NOT pass XDG_ prefixed vars on Windows', () => {
    const result = buildCleanEnv(windowsEnv, true)
    expect(result.XDG_DATA_HOME).toBeUndefined()
  })

  it('does NOT pass random unknown vars', () => {
    const result = buildCleanEnv(windowsEnv, true)
    expect(result.MY_CUSTOM_VAR).toBeUndefined()
  })

  it('always sets ELECTRON_RUN_AS_NODE=1', () => {
    const result = buildCleanEnv(windowsEnv, true)
    expect(result.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('overwrites ELECTRON_RUN_AS_NODE even if env has a different value', () => {
    const result = buildCleanEnv({ ...windowsEnv, ELECTRON_RUN_AS_NODE: '0' }, true)
    expect(result.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('skips env vars with empty/undefined values', () => {
    const env = {
      SYSTEMROOT: '',
      WINDIR: undefined as unknown as string,
      COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    }
    const result = buildCleanEnv(env, true)
    expect(result.SYSTEMROOT).toBeUndefined()
    expect(result.WINDIR).toBeUndefined()
    expect(result.COMSPEC).toBe('C:\\Windows\\system32\\cmd.exe')
  })
})

// ---------------------------------------------------------------------------
// buildCleanEnv — Unix mode
// ---------------------------------------------------------------------------
describe('buildCleanEnv (Unix)', () => {
  const unixEnv: Record<string, string> = {
    HOME: '/home/testuser',
    USER: 'testuser',
    LOGNAME: 'testuser',
    SHELL: '/bin/zsh',
    PATH: '/usr/local/bin:/usr/bin',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    TEMP: '/tmp',
    TMP: '/tmp',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    DISPLAY: ':0',
    COLORTERM: 'truecolor',
    LC_ALL: 'en_US.UTF-8',
    XDG_DATA_HOME: '/home/testuser/.local/share',
    ANTHROPIC_API_KEY: 'sk-ant-key',
    CLAUDE_CODE_SETTING: 'true',
    // Blocked
    NODE_OPTIONS: '--max-old-space-size=8192',
    CLAUDECODE: '1',
    DEBUG: '*',
    ELECTRON_OZONE_PLATFORM: 'wayland',
    // Windows-only vars that should NOT appear on Unix
    SYSTEMROOT: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    APPDATA: 'C:\\Users\\Test\\AppData',
  }

  it('passes through Unix-specific vars', () => {
    const result = buildCleanEnv(unixEnv, false)
    expect(result.HOME).toBe('/home/testuser')
    expect(result.USER).toBe('testuser')
    expect(result.LOGNAME).toBe('testuser')
    expect(result.SHELL).toBe('/bin/zsh')
    expect(result.TMPDIR).toBe('/tmp')
    expect(result.TERM).toBe('xterm-256color')
    expect(result.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock')
    expect(result.DISPLAY).toBe(':0')
    expect(result.COLORTERM).toBe('truecolor')
  })

  it('passes through common vars', () => {
    const result = buildCleanEnv(unixEnv, false)
    expect(result.PATH).toBe('/usr/local/bin:/usr/bin')
    expect(result.LANG).toBe('en_US.UTF-8')
    expect(result.TEMP).toBe('/tmp')
    expect(result.TMP).toBe('/tmp')
  })

  it('passes through LC_ and XDG_ prefixed vars on Unix', () => {
    const result = buildCleanEnv(unixEnv, false)
    expect(result.LC_ALL).toBe('en_US.UTF-8')
    expect(result.XDG_DATA_HOME).toBe('/home/testuser/.local/share')
  })

  it('passes through ANTHROPIC_ and CLAUDE_ prefixed vars', () => {
    const result = buildCleanEnv(unixEnv, false)
    expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-key')
    expect(result.CLAUDE_CODE_SETTING).toBe('true')
  })

  it('blocks dangerous vars', () => {
    const result = buildCleanEnv(unixEnv, false)
    expect(result.NODE_OPTIONS).toBeUndefined()
    expect(result.CLAUDECODE).toBeUndefined()
    expect(result.DEBUG).toBeUndefined()
    expect(result.ELECTRON_OZONE_PLATFORM).toBeUndefined()
  })

  it('does NOT pass Windows-only vars on Unix', () => {
    const result = buildCleanEnv(unixEnv, false)
    expect(result.SYSTEMROOT).toBeUndefined()
    expect(result.WINDIR).toBeUndefined()
    expect(result.COMSPEC).toBeUndefined()
    expect(result.APPDATA).toBeUndefined()
  })

  it('always sets ELECTRON_RUN_AS_NODE=1', () => {
    const result = buildCleanEnv(unixEnv, false)
    expect(result.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// buildCleanEnv — edge cases
// ---------------------------------------------------------------------------
describe('buildCleanEnv (edge cases)', () => {
  it('handles completely empty environment', () => {
    const resultWin = buildCleanEnv({}, true)
    const resultUnix = buildCleanEnv({}, false)
    // Should only have ELECTRON_RUN_AS_NODE
    expect(Object.keys(resultWin)).toEqual(['ELECTRON_RUN_AS_NODE'])
    expect(Object.keys(resultUnix)).toEqual(['ELECTRON_RUN_AS_NODE'])
  })

  it('preserves original key casing from the environment', () => {
    // Windows sometimes stores "Path" instead of "PATH"
    const env = { Path: 'C:\\Windows', temp: 'C:\\Temp' }
    const result = buildCleanEnv(env, true)
    // Key should be "Path" not "PATH"
    expect('Path' in result).toBe(true)
    expect('PATH' in result).toBe(false)
    // "temp" should match TEMP via case-insensitive comparison
    expect('temp' in result).toBe(true)
    expect('TEMP' in result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getCliAccessFlag
// ---------------------------------------------------------------------------
describe('getCliAccessFlag', () => {
  it('returns R_OK (4) on Windows', () => {
    expect(getCliAccessFlag(true)).toBe(fsConstants.R_OK)
    expect(getCliAccessFlag(true)).toBe(4)
  })

  it('returns X_OK (1) on Unix', () => {
    expect(getCliAccessFlag(false)).toBe(fsConstants.X_OK)
    expect(getCliAccessFlag(false)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// getCliAccessError
// ---------------------------------------------------------------------------
describe('getCliAccessError', () => {
  it('returns "not readable" message on Windows', () => {
    const msg = getCliAccessError('C:\\app\\cli.js', true)
    expect(msg).toContain('not readable')
    expect(msg).toContain('C:\\app\\cli.js')
    expect(msg).not.toContain('not executable')
  })

  it('returns "not executable" message on Unix', () => {
    const msg = getCliAccessError('/usr/local/bin/cli.js', false)
    expect(msg).toContain('not executable')
    expect(msg).toContain('/usr/local/bin/cli.js')
    expect(msg).not.toContain('not readable')
  })
})
