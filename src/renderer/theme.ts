// Centralized design tokens for Fluidstate AI — light & dark themes
// Derived from fs-code-landing OKLch palette (converted to hex)

export type ThemeMode = 'light' | 'dark'

// ── Dark theme (neutral blacks matching landing page .dark) ────────

const darkColors = {
  // Backgrounds
  bg: '#1a1a1a',
  bgSurface: '#222222',
  bgOverlay: '#141414',
  bgFrosted: 'rgba(26, 26, 26, 0.85)',

  // Borders
  border: '#383838',
  borderMuted: '#3d3d3d',

  // Text
  text: '#f9f9f9',
  textSecondary: '#b8b8b8',
  textMuted: '#888888',
  textLink: '#58a6ff',

  // Phase colors (bright for dark bg)
  phaseIdle: '#888888',
  phaseThinking: '#bc8cff',
  phaseResearching: '#79c0ff',
  phaseSearching: '#7ee787',
  phasePlanning: '#58a6ff',
  phaseCoding: '#3fb950',
  phaseTesting: '#d29922',
  phaseDebugging: '#ffa657',
  phaseReviewing: '#f778ba',
  phaseDone: '#3fb950',
  phaseStuck: '#f85149',
  phaseAwaiting: '#f85149',

  // File operation dots
  dotRead: '#58a6ff',
  dotWrite: '#3fb950',
  dotCreate: '#a371f7',
  dotExecute: '#d29922',

  // Diff viewer
  diffAddBg: 'rgba(63, 185, 80, 0.15)',
  diffAddBorder: 'rgba(63, 185, 80, 0.4)',
  diffAddText: '#3fb950',
  diffRemoveBg: 'rgba(248, 81, 73, 0.15)',
  diffRemoveBorder: 'rgba(248, 81, 73, 0.4)',
  diffRemoveText: '#f85149',
  diffHunkBg: 'rgba(56, 139, 253, 0.10)',
  diffHunkText: '#79c0ff',
  diffLineNum: '#888888',
  diffLineNumActive: '#b8b8b8',

  // Accents
  green: '#3fb950',
  blue: '#58a6ff',
  purple: '#a371f7',
  amber: '#d29922',
  pink: '#f778ba',
  red: '#f85149',

  // Modal overlay
  modalOverlay: 'rgba(0, 0, 0, 0.5)',
  fileModalOverlay: 'rgba(10, 10, 10, 0.9)',
} as const

// ── Light theme (matching landing page :root) ─────────────────────

const lightColors = {
  // Backgrounds
  bg: '#ffffff',
  bgSurface: '#f5f5f5',
  bgOverlay: '#fafafa',
  bgFrosted: 'rgba(255, 255, 255, 0.85)',

  // Borders
  border: '#e5e5e5',
  borderMuted: '#ebebeb',

  // Text
  text: '#1b1b1b',
  textSecondary: '#7c7c7c',
  textMuted: '#999999',
  textLink: '#0969da',

  // Phase colors (darker for light bg)
  phaseIdle: '#8b949e',
  phaseThinking: '#8250df',
  phaseResearching: '#0969da',
  phaseSearching: '#1a7f37',
  phasePlanning: '#0550ae',
  phaseCoding: '#1a7f37',
  phaseTesting: '#9a6700',
  phaseDebugging: '#bc4c00',
  phaseReviewing: '#bf3989',
  phaseDone: '#1a7f37',
  phaseStuck: '#cf222e',
  phaseAwaiting: '#cf222e',

  // File operation dots
  dotRead: '#0969da',
  dotWrite: '#1a7f37',
  dotCreate: '#8250df',
  dotExecute: '#9a6700',

  // Diff viewer
  diffAddBg: 'rgba(26, 127, 55, 0.10)',
  diffAddBorder: 'rgba(26, 127, 55, 0.3)',
  diffAddText: '#1a7f37',
  diffRemoveBg: 'rgba(207, 34, 46, 0.10)',
  diffRemoveBorder: 'rgba(207, 34, 46, 0.3)',
  diffRemoveText: '#cf222e',
  diffHunkBg: 'rgba(9, 105, 218, 0.08)',
  diffHunkText: '#0969da',
  diffLineNum: '#999999',
  diffLineNumActive: '#7c7c7c',

  // Accents
  green: '#1a7f37',
  blue: '#0969da',
  purple: '#8250df',
  amber: '#9a6700',
  pink: '#bf3989',
  red: '#cf222e',

  // Modal overlay
  modalOverlay: 'rgba(0, 0, 0, 0.3)',
  fileModalOverlay: 'rgba(240, 240, 240, 0.9)',
} as const

export type ThemeColors = typeof darkColors

// ── Shared constants (theme-independent) ──────────────────────────

export const fonts = {
  ui: "'Geist Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
  mono: "'Geist Mono', ui-monospace, 'SF Mono', 'Fira Code', monospace",
} as const

export const spacing = {
  titleBarHeight: 38,
  journeyBarHeight: 44,
  statusBarHeight: 28,
  sidebarWidth: 280,
  conversationMaxWidth: 720,
  terminalDefaultHeight: 220,
  agentCellHeaderHeight: 32,
  commandPaletteWidth: 480,
} as const

export const phaseLabelMap: Record<string, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  researching: 'Researching',
  searching: 'Searching',
  planning: 'Planning',
  coding: 'Coding',
  testing: 'Testing',
  debugging: 'Debugging',
  reviewing: 'Reviewing',
  done: 'Done',
  stuck: 'Stuck',
  awaiting: 'Awaiting',
}

// ── Theme builders ────────────────────────────────────────────────

function buildPhaseColorMap(c: ThemeColors): Record<string, string> {
  return {
    idle: c.phaseIdle,
    thinking: c.phaseThinking,
    researching: c.phaseResearching,
    searching: c.phaseSearching,
    planning: c.phasePlanning,
    coding: c.phaseCoding,
    testing: c.phaseTesting,
    debugging: c.phaseDebugging,
    reviewing: c.phaseReviewing,
    done: c.phaseDone,
    stuck: c.phaseStuck,
    awaiting: c.phaseAwaiting,
  }
}

export const lightTheme = {
  colors: lightColors,
  fonts,
  spacing,
  agentColors: [lightColors.blue, lightColors.purple, lightColors.amber, lightColors.pink] as const,
  phaseColorMap: buildPhaseColorMap(lightColors),
}

export const darkTheme = {
  colors: darkColors,
  fonts,
  spacing,
  agentColors: [darkColors.blue, darkColors.purple, darkColors.amber, darkColors.pink] as const,
  phaseColorMap: buildPhaseColorMap(darkColors),
}
