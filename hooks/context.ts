import type { SessionContextBreakdown } from 'claude-code'

import type { ContextRow, ContextSnapshot, McpServerRow } from '../types'

export const FREE_COLOR = '#343a4f'
export const BUFFER_COLOR = '#4b5168'

// /context's row names, keyed lowercase, as the app's card labels and colours them.
const LOOK: Record<string, { label: string; color: string }> = {
  'system prompt': { label: 'system prompt', color: '#6b9bd8' },
  'system tools': { label: 'tools', color: '#5ec4c8' },
  'mcp tools': { label: 'mcp tools', color: '#9b87f5' },
  'custom agents': { label: 'agents', color: '#8cc97a' },
  'memory files': { label: 'memory files', color: '#e8c25a' },
  skills: { label: 'skills', color: '#f0a0c0' },
  messages: { label: 'messages', color: '#e07050' },
}

export function toSnapshot(b: SessionContextBreakdown, costUsd: number | null = null): ContextSnapshot {
  const rows: ContextRow[] = []
  let free = 0
  let buffer = 0

  for (const cat of b.categories) {
    if (cat.kind === 'free') {
      free += cat.tokens
    } else if (cat.kind === 'buffer') {
      buffer += cat.tokens
    } else if (cat.kind === 'used') {
      const look = LOOK[cat.name.toLowerCase()]
      rows.push({
        label: look?.label ?? cat.name.toLowerCase(),
        tokens: cat.tokens,
        color: look?.color ?? cat.color,
      })
    }
  }

  return {
    rows,
    used: b.totalTokens,
    free,
    buffer,
    max: b.rawMaxTokens,
    compactsAt:
      b.isAutoCompactEnabled && b.autoCompactThreshold !== undefined
        ? b.autoCompactThreshold
        : null,
    mcpServers: mcpServers(b),
    costUsd,
  }
}

// Groups the MCP tool schemas by server, heaviest first. Only loaded schemas
// count toward `tokens`: deferred ones sit outside the window until searched for.
export function mcpServers(b: SessionContextBreakdown): McpServerRow[] {
  const byName = new Map<string, McpServerRow>()
  for (const tool of b.mcpTools) {
    const row = byName.get(tool.serverName) ?? {
      name: tool.serverName,
      tokens: 0,
      tools: 0,
      deferred: 0,
    }
    row.tools += 1
    if (tool.isLoaded) {
      row.tokens += tool.tokens
    } else {
      row.deferred += 1
    }
    byName.set(tool.serverName, row)
  }

  return [...byName.values()].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
}

export type Segment = { key: string; color: string; glyph: string; cells: number }

// Splits `width` cells among the rows, then the buffer, the free space taking
// what is left. Cumulative rounding keeps the sum exact; a row with any tokens
// gets at least one cell.
export function segments(snap: ContextSnapshot, width: number): Segment[] {
  const out: Segment[] = []
  const max = Math.max(1, snap.max)
  let cum = 0
  let edge = 0

  for (const row of snap.rows) {
    cum += row.tokens
    const next = Math.min(width, Math.round((cum / max) * width))
    let cells = Math.max(0, next - edge)
    if (row.tokens > 0 && cells < 1 && edge < width) {
      cells = 1
    }
    edge += cells
    if (cells > 0) {
      out.push({ key: row.label, color: row.color, glyph: '█', cells })
    }
  }

  const bufferCells = Math.min(
    Math.max(0, width - edge),
    Math.round((snap.buffer / max) * width),
  )
  const freeCells = Math.max(0, width - edge - bufferCells)
  if (freeCells > 0) {
    out.push({ key: 'free', color: FREE_COLOR, glyph: '█', cells: freeCells })
  }
  if (bufferCells > 0) {
    out.push({ key: 'buffer', color: BUFFER_COLOR, glyph: '░', cells: bufferCells })
  }

  return out
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`
  }
  if (n >= 1000) {
    const k = n / 1000
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
  }
  return String(Math.round(n))
}

export function fmtPct(n: number, max: number): string {
  return `${Math.round((n / Math.max(1, max)) * 100)}%`
}

export function fmtUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}

// What follows the bold used figure in the header: ` of 1M · compacts at 95% · $1.23`.
export function headerRest(snap: ContextSnapshot): string {
  let rest = ` of ${fmtTokens(snap.max)}`
  if (snap.compactsAt !== null) {
    rest += ` · compacts at ${fmtPct(snap.compactsAt, snap.max)}`
  }
  if (snap.costUsd !== null) {
    rest += ` · ${fmtUsd(snap.costUsd)}`
  }
  return rest
}

// `claude-opus-5-5[1m]` → `Opus 5.5 1M`; an id it does not know passes through.
export function fmtModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(id)
  if (!m) {
    return id
  }
  const [, family = '', major, minor, wide] = m
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return `${name} ${major}${minor ? `.${minor}` : ''}${wide ? ' 1M' : ''}`
}

export function fmtEffort(effort: string | number | undefined): string | null {
  return effort === undefined ? null : String(effort)
}

// --- Compact mode: the window as a weather forecast, like token-weather ---

export const HISTORY = 12
// Lower blocks only: they share one baseline. A full block (█) is drawn the line's whole
// height on desktop fonts and drops below the others, so the tallest reading tops out at ▇.
const BARS = '▁▂▃▄▅▆▇'

export type Forecast = { icon: string; word: string; color: string }

// Single-width text symbols, not emoji: they line up in every terminal font.
const FORECAST: (Forecast & { upTo: number })[] = [
  { upTo: 25, icon: '☀', word: 'Clear', color: '#e8c25a' },
  { upTo: 50, icon: '☁', word: 'Cloudy', color: '#5ec4c8' },
  { upTo: 75, icon: '☂', word: 'Showers', color: '#6b9bd8' },
  { upTo: 90, icon: '☇', word: 'Storm', color: '#9b87f5' },
  { upTo: Infinity, icon: '↯', word: 'Compact soon', color: '#e07050' },
]

export function forecastFor(percent: number): Forecast {
  return FORECAST.find(f => percent < f.upTo) ?? FORECAST[FORECAST.length - 1]!
}

export function usedPercent(snap: ContextSnapshot): number {
  return Math.round((snap.used / Math.max(1, snap.max)) * 100)
}

// Adds a reading when the fill moved, keeping the last HISTORY.
export function pushReading(history: number[], tokens: number): number[] {
  if (tokens <= 0 || history[history.length - 1] === tokens) {
    return history
  }
  return [...history, tokens].slice(-HISTORY)
}

// Bars scale to the busiest reading shown, so growth shows at any fill level.
export function sparkline(history: number[]): string {
  const top = Math.max(1, ...history)
  return history
    .map(t => BARS[Math.min(BARS.length - 1, Math.floor((t / top) * (BARS.length - 1)))])
    .join('')
}

export function trend(history: number[]): string {
  if (history.length < 2) {
    return ''
  }
  const delta = history[history.length - 1]! - history[history.length - 2]!
  if (delta > 0) return `▲ +${fmtTokens(delta)}`
  if (delta < 0) return `▼ ${fmtTokens(-delta)}`
  return ''
}

// Folds the categories under `min` tokens into one "others" row, so the legend stays short.
// A single small category keeps its own name: folding it alone would only hide it.
export function groupSmall(snap: ContextSnapshot, min = 4000): ContextSnapshot {
  const small = snap.rows.filter(r => r.tokens > 0 && r.tokens < min)
  if (small.length < 2) return snap
  const big = snap.rows.filter(r => r.tokens >= min)
  const others = { label: 'others', tokens: small.reduce((n, r) => n + r.tokens, 0), color: '#a2845e' }
  return { ...snap, rows: [...big, others] }
}
