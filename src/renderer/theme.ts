// Centralized design tokens for Fluidstate AI
// Multiple color themes

export type ThemeMode = 'dark' | 'light' | 'midnight' | 'sakura' | 'matcha' | 'wabi' | 'claude'

export interface ThemeInfo {
  id: ThemeMode
  label: string
  description: string
  swatch: string // preview color for the picker
}

export const themeList: ThemeInfo[] = [
  { id: 'dark',     label: 'Charcoal', description: 'Warm charcoal',   swatch: '#1e1e1e' },
  { id: 'light',    label: 'Light',    description: 'Clean daylight',  swatch: '#ffffff' },
  { id: 'midnight', label: 'Midnight', description: 'Deep indigo',     swatch: '#0f0f1a' },
  { id: 'sakura',   label: 'Rose',     description: 'Blush pink',      swatch: '#1a1018' },
  { id: 'matcha',   label: 'Forest',   description: 'Forest green',    swatch: '#0e1610' },
  { id: 'wabi',     label: 'Clay',     description: 'Aged clay',       swatch: '#1c1714' },
  { id: 'claude',   label: 'Claude',   description: 'Anthropic',       swatch: '#d97757' },
]

// ── Charcoal — warm charcoal (default dark) ─────────────────────

const darkColors = {
  bg: '#1e1e1e',
  bgSurface: '#262626',
  bgOverlay: '#181818',
  bgFrosted: 'rgba(30, 30, 30, 0.88)',

  border: '#3c3c3c',
  borderMuted: '#333333',

  text: '#e8e4df',
  textSecondary: '#a8a29e',
  textMuted: '#6b6560',
  textLink: '#7ab0ff',

  phaseIdle: '#6b6560',
  phaseThinking: '#c4a1ff',
  phaseResearching: '#7ab0ff',
  phaseSearching: '#7ee787',
  phasePlanning: '#7ab0ff',
  phaseCoding: '#4aca60',
  phaseTesting: '#e0a832',
  phaseDebugging: '#ffb068',
  phaseReviewing: '#f47ebd',
  phaseDone: '#4aca60',
  phaseStuck: '#f85149',
  phaseAwaiting: '#f85149',

  dotRead: '#7ab0ff',
  dotWrite: '#4aca60',
  dotCreate: '#b490f7',
  dotExecute: '#e0a832',

  diffAddBg: 'rgba(74, 202, 96, 0.12)',
  diffAddBorder: 'rgba(74, 202, 96, 0.35)',
  diffAddText: '#4aca60',
  diffRemoveBg: 'rgba(248, 81, 73, 0.12)',
  diffRemoveBorder: 'rgba(248, 81, 73, 0.35)',
  diffRemoveText: '#f85149',
  diffHunkBg: 'rgba(122, 176, 255, 0.08)',
  diffHunkText: '#7ab0ff',
  diffLineNum: '#6b6560',
  diffLineNumActive: '#a8a29e',

  green: '#4aca60',
  blue: '#7ab0ff',
  purple: '#b490f7',
  amber: '#e0a832',
  pink: '#f47ebd',
  red: '#f85149',

  modalOverlay: 'rgba(0, 0, 0, 0.45)',
  fileModalOverlay: 'rgba(18, 18, 18, 0.88)',
} as const

// ── Light — clean daylight ──────────────────────────────────────

const lightColors = {
  bg: '#ffffff',
  bgSurface: '#f5f5f5',
  bgOverlay: '#fafafa',
  bgFrosted: 'rgba(255, 255, 255, 0.85)',

  border: '#e5e5e5',
  borderMuted: '#ebebeb',

  text: '#1b1b1b',
  textSecondary: '#7c7c7c',
  textMuted: '#999999',
  textLink: '#0969da',

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

  dotRead: '#0969da',
  dotWrite: '#1a7f37',
  dotCreate: '#8250df',
  dotExecute: '#9a6700',

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

  green: '#1a7f37',
  blue: '#0969da',
  purple: '#8250df',
  amber: '#9a6700',
  pink: '#bf3989',
  red: '#cf222e',

  modalOverlay: 'rgba(0, 0, 0, 0.3)',
  fileModalOverlay: 'rgba(240, 240, 240, 0.9)',
} as const

// ── Midnight — deep indigo ──────────────────────────────────────

const midnightColors = {
  bg: '#0f0f1a',
  bgSurface: '#161625',
  bgOverlay: '#0a0a14',
  bgFrosted: 'rgba(15, 15, 26, 0.90)',

  border: '#2a2a44',
  borderMuted: '#222238',

  text: '#d8d8e8',
  textSecondary: '#9090b0',
  textMuted: '#585878',
  textLink: '#8ab4ff',

  phaseIdle: '#585878',
  phaseThinking: '#c8a8ff',
  phaseResearching: '#8ab4ff',
  phaseSearching: '#6ce080',
  phasePlanning: '#8ab4ff',
  phaseCoding: '#50d070',
  phaseTesting: '#e8b030',
  phaseDebugging: '#ffa860',
  phaseReviewing: '#f080c0',
  phaseDone: '#50d070',
  phaseStuck: '#f06060',
  phaseAwaiting: '#f06060',

  dotRead: '#8ab4ff',
  dotWrite: '#50d070',
  dotCreate: '#b898f8',
  dotExecute: '#e8b030',

  diffAddBg: 'rgba(80, 208, 112, 0.10)',
  diffAddBorder: 'rgba(80, 208, 112, 0.30)',
  diffAddText: '#50d070',
  diffRemoveBg: 'rgba(240, 96, 96, 0.10)',
  diffRemoveBorder: 'rgba(240, 96, 96, 0.30)',
  diffRemoveText: '#f06060',
  diffHunkBg: 'rgba(138, 180, 255, 0.08)',
  diffHunkText: '#8ab4ff',
  diffLineNum: '#585878',
  diffLineNumActive: '#9090b0',

  green: '#50d070',
  blue: '#8ab4ff',
  purple: '#b898f8',
  amber: '#e8b030',
  pink: '#f080c0',
  red: '#f06060',

  modalOverlay: 'rgba(0, 0, 0, 0.55)',
  fileModalOverlay: 'rgba(10, 10, 18, 0.92)',
} as const

// ── Rose — soft blush pink on deep plum ─────────────────────────

const sakuraColors = {
  bg: '#1a1018',
  bgSurface: '#221820',
  bgOverlay: '#150e14',
  bgFrosted: 'rgba(26, 16, 24, 0.90)',

  border: '#3d2838',
  borderMuted: '#332230',

  text: '#ede0e8',
  textSecondary: '#b098a8',
  textMuted: '#785868',
  textLink: '#f0a0c0',

  phaseIdle: '#785868',
  phaseThinking: '#d8a0f0',
  phaseResearching: '#a0b8f0',
  phaseSearching: '#80d890',
  phasePlanning: '#a0b8f0',
  phaseCoding: '#60c870',
  phaseTesting: '#e8c040',
  phaseDebugging: '#f0b870',
  phaseReviewing: '#f088b8',
  phaseDone: '#60c870',
  phaseStuck: '#e86068',
  phaseAwaiting: '#e86068',

  dotRead: '#a0b8f0',
  dotWrite: '#60c870',
  dotCreate: '#d8a0f0',
  dotExecute: '#e8c040',

  diffAddBg: 'rgba(96, 200, 112, 0.10)',
  diffAddBorder: 'rgba(96, 200, 112, 0.30)',
  diffAddText: '#60c870',
  diffRemoveBg: 'rgba(232, 96, 104, 0.10)',
  diffRemoveBorder: 'rgba(232, 96, 104, 0.30)',
  diffRemoveText: '#e86068',
  diffHunkBg: 'rgba(240, 160, 192, 0.08)',
  diffHunkText: '#f0a0c0',
  diffLineNum: '#785868',
  diffLineNumActive: '#b098a8',

  green: '#60c870',
  blue: '#a0b8f0',
  purple: '#d8a0f0',
  amber: '#e8c040',
  pink: '#f088b8',
  red: '#e86068',

  modalOverlay: 'rgba(0, 0, 0, 0.50)',
  fileModalOverlay: 'rgba(20, 12, 18, 0.90)',
} as const

// ── Forest — deep forest green ──────────────────────────────────

const matchaColors = {
  bg: '#0e1610',
  bgSurface: '#161e18',
  bgOverlay: '#0a120c',
  bgFrosted: 'rgba(14, 22, 16, 0.90)',

  border: '#283830',
  borderMuted: '#203028',

  text: '#d8e8dc',
  textSecondary: '#90a898',
  textMuted: '#587060',
  textLink: '#80c890',

  phaseIdle: '#587060',
  phaseThinking: '#b8a0e0',
  phaseResearching: '#80b8e0',
  phaseSearching: '#70d880',
  phasePlanning: '#80b8e0',
  phaseCoding: '#58d068',
  phaseTesting: '#d8b830',
  phaseDebugging: '#e8a858',
  phaseReviewing: '#e080a8',
  phaseDone: '#58d068',
  phaseStuck: '#e06058',
  phaseAwaiting: '#e06058',

  dotRead: '#80b8e0',
  dotWrite: '#58d068',
  dotCreate: '#b8a0e0',
  dotExecute: '#d8b830',

  diffAddBg: 'rgba(88, 208, 104, 0.10)',
  diffAddBorder: 'rgba(88, 208, 104, 0.30)',
  diffAddText: '#58d068',
  diffRemoveBg: 'rgba(224, 96, 88, 0.10)',
  diffRemoveBorder: 'rgba(224, 96, 88, 0.30)',
  diffRemoveText: '#e06058',
  diffHunkBg: 'rgba(128, 200, 144, 0.08)',
  diffHunkText: '#80c890',
  diffLineNum: '#587060',
  diffLineNumActive: '#90a898',

  green: '#58d068',
  blue: '#80b8e0',
  purple: '#b8a0e0',
  amber: '#d8b830',
  pink: '#e080a8',
  red: '#e06058',

  modalOverlay: 'rgba(0, 0, 0, 0.50)',
  fileModalOverlay: 'rgba(10, 16, 12, 0.92)',
} as const

// ── Clay — aged clay / weathered earth ──────────────────────────

const wabiColors = {
  bg: '#1c1714',
  bgSurface: '#241e1a',
  bgOverlay: '#161210',
  bgFrosted: 'rgba(28, 23, 20, 0.90)',

  border: '#3c3230',
  borderMuted: '#332a28',

  text: '#e0d8d0',
  textSecondary: '#a89888',
  textMuted: '#6e5e50',
  textLink: '#c8a070',

  phaseIdle: '#6e5e50',
  phaseThinking: '#c0a0d8',
  phaseResearching: '#90b0d0',
  phaseSearching: '#78c878',
  phasePlanning: '#90b0d0',
  phaseCoding: '#58b860',
  phaseTesting: '#d0a830',
  phaseDebugging: '#e0a050',
  phaseReviewing: '#d880a0',
  phaseDone: '#58b860',
  phaseStuck: '#d86050',
  phaseAwaiting: '#d86050',

  dotRead: '#90b0d0',
  dotWrite: '#58b860',
  dotCreate: '#c0a0d8',
  dotExecute: '#d0a830',

  diffAddBg: 'rgba(88, 184, 96, 0.10)',
  diffAddBorder: 'rgba(88, 184, 96, 0.30)',
  diffAddText: '#58b860',
  diffRemoveBg: 'rgba(216, 96, 80, 0.10)',
  diffRemoveBorder: 'rgba(216, 96, 80, 0.30)',
  diffRemoveText: '#d86050',
  diffHunkBg: 'rgba(200, 160, 112, 0.08)',
  diffHunkText: '#c8a070',
  diffLineNum: '#6e5e50',
  diffLineNumActive: '#a89888',

  green: '#58b860',
  blue: '#90b0d0',
  purple: '#c0a0d8',
  amber: '#d0a830',
  pink: '#d880a0',
  red: '#d86050',

  modalOverlay: 'rgba(0, 0, 0, 0.50)',
  fileModalOverlay: 'rgba(20, 16, 14, 0.90)',
} as const

// ── Claude — Anthropic brand (cream & rust on warm dark) ────────

const claudeColors = {
  bg: '#1a1915',
  bgSurface: '#23221c',
  bgOverlay: '#141310',
  bgFrosted: 'rgba(26, 25, 21, 0.90)',

  border: '#3a3830',
  borderMuted: '#302e28',

  text: '#ece8df',
  textSecondary: '#b0a898',
  textMuted: '#6e6658',
  textLink: '#d97757',

  phaseIdle: '#6e6658',
  phaseThinking: '#d97757',
  phaseResearching: '#c89868',
  phaseSearching: '#78b868',
  phasePlanning: '#c89868',
  phaseCoding: '#78b868',
  phaseTesting: '#eda100',
  phaseDebugging: '#d97757',
  phaseReviewing: '#c87878',
  phaseDone: '#78b868',
  phaseStuck: '#d06050',
  phaseAwaiting: '#d06050',

  dotRead: '#c89868',
  dotWrite: '#78b868',
  dotCreate: '#d97757',
  dotExecute: '#eda100',

  diffAddBg: 'rgba(120, 184, 104, 0.10)',
  diffAddBorder: 'rgba(120, 184, 104, 0.30)',
  diffAddText: '#78b868',
  diffRemoveBg: 'rgba(208, 96, 80, 0.10)',
  diffRemoveBorder: 'rgba(208, 96, 80, 0.30)',
  diffRemoveText: '#d06050',
  diffHunkBg: 'rgba(217, 119, 87, 0.08)',
  diffHunkText: '#d97757',
  diffLineNum: '#6e6658',
  diffLineNumActive: '#b0a898',

  green: '#78b868',
  blue: '#c89868',
  purple: '#d97757',
  amber: '#eda100',
  pink: '#c87878',
  red: '#d06050',

  modalOverlay: 'rgba(0, 0, 0, 0.50)',
  fileModalOverlay: 'rgba(18, 17, 14, 0.92)',
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

function buildTheme(colors: ThemeColors) {
  return {
    colors,
    fonts,
    spacing,
    agentColors: [colors.blue, colors.purple, colors.amber, colors.pink] as const,
    phaseColorMap: buildPhaseColorMap(colors),
  }
}

export const themes: Record<ThemeMode, ReturnType<typeof buildTheme>> = {
  dark: buildTheme(darkColors),
  light: buildTheme(lightColors),
  midnight: buildTheme(midnightColors),
  sakura: buildTheme(sakuraColors),
  matcha: buildTheme(matchaColors),
  wabi: buildTheme(wabiColors),
  claude: buildTheme(claudeColors),
}

// Back-compat aliases
export const lightTheme = themes.light
export const darkTheme = themes.dark
