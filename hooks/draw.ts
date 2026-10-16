import type { AgentRow, ContextSnapshot, Goal, MainMood, MainRow, Note, RunInfo } from '../types'
import { fmtModel, fmtPct, fmtTokens, fmtUsd, segments, usedPercent } from './context'
import { activeGoal, verdict } from './goals'

// macOS system colors, light then dark, by role. The drawing is an image, so it follows the
// scheme through a media query rather than the app's theme keys.
const STYLE = `<style>
text{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;font-variant-numeric:tabular-nums}
.l{fill:#1d1d1f}.s{fill:#6e6e73}.t{fill:#aeaeb2}.tr{fill:#e5e5ea}.bf{fill:#d1d1d6}
.b{fill:#007aff}.g{fill:#34c759}.o{fill:#ff9500}.r{fill:#ff3b30}.dim{opacity:.45}
.ring{fill:none;stroke:#aeaeb2;stroke-width:1.5}.dash{stroke-dasharray:2 2}\n.slide{transform-box:fill-box;animation:slide 1.6s ease-in-out infinite alternate}@keyframes slide{from{transform:translateX(0)}to{transform:translateX(233%)}}\n@media (prefers-reduced-motion: reduce){.slide{animation:none}}
@media (prefers-color-scheme: dark){
.l{fill:#f5f5f7}.s{fill:#98989d}.t{fill:#636366}.tr{fill:#3a3a3c}.bf{fill:#48484a}
.b{fill:#0a84ff}.g{fill:#30d158}.o{fill:#ff9f0a}.r{fill:#ff453a}.ring{stroke:#636366}}
</style>`

// The categories of the window, in system hues (orange and blue stay free for attention and goals).
const CAT: Record<string, string> = {
  'system prompt': '#8e8e93',
  tools: '#30b0c7',
  'mcp tools': '#af52de',
  agents: '#00c7be',
  'memory files': '#ffcc00',
  skills: '#ff2d55',
  messages: '#5856d6',
  others: '#a2845e',
}
export const catColor = (label: string): string => CAT[label] ?? '#a2845e'

export const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Rough advance of the system UI font, in em; enough to size slots and cut titles.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]·]/.test(ch) ? 0.28 : /[A-ZmwMW@%]/.test(ch) ? 0.72 : 0.55
export const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

export function fit(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size) > maxW) break
    out += ch
  }
  return `${out}…`
}

export const svg = (W: number, H: number, body: string, extra = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${STYLE}${extra}${body}</svg>`

// Clawd's poses, one per state an agent row shows; each a symbol `#k<pose>` and the style that
// steps its frames. A pose the sprites lack draws a dot instead.
export type Pose = 'hop' | 'thinking' | 'look' | 'laptop' | 'confetti' | 'disappointed' | 'desktop' | 'meditate' | 'wave' | 'hula' | 'dizzy'
export type Clip = { symbol: string; style: string; w: number; h: number }
export type Cast = Partial<Record<Pose, Clip>>

// Which sprite each pose plays, as clawd-desk's clips do: the frames it loops, every `step`th.
export const POSES: Record<Pose, { sprite: string; from: number; to: number; step: number }> = {
  hop: { sprite: 'JumpingHappy', from: 0, to: 20, step: 2 },
  thinking: { sprite: 'Thinking', from: 0, to: 37, step: 2 },
  look: { sprite: 'LookingAround', from: 0, to: 30, step: 2 },
  laptop: { sprite: 'Laptop', from: 17, to: 33, step: 2 },
  confetti: { sprite: 'Confetti', from: 0, to: 33, step: 2 },
  disappointed: { sprite: 'Disappointed', from: 0, to: 42, step: 2 },
  desktop: { sprite: 'Desktop', from: 20, to: 77, step: 2 },
  meditate: { sprite: 'Meditating', from: 0, to: 59, step: 2 },
  wave: { sprite: 'Waving', from: 6, to: 16, step: 1 },
  hula: { sprite: 'Hula', from: 0, to: 53, step: 2 },
  dizzy: { sprite: 'Dizzy', from: 0, to: 40, step: 2 },
}

// Tools that look around rather than change anything.
const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead'])

export function agentPose(a: AgentRow): Pose {
  if (a.status === 'done') return 'confetti'
  if (a.status === 'failed') return 'disappointed'
  if (a.isThinking) return 'thinking'
  if (!a.lastTool) return a.steps === 0 ? 'hop' : 'thinking'
  return READS.has(a.lastTool) ? 'look' : 'laptop'
}

const MOOD_POSE: Record<MainMood, Pose> = { working: 'desktop', stopped: 'dizzy', needs: 'wave', agents: 'meditate', idle: 'hula' }
export const mainPose = (m: MainRow): Pose => MOOD_POSE[m.mood]

// Every pose sits in one box, scaled to fit, so the text beside it starts at one column.
const ART_W = 34
const ART_H = 28

function art(cast: Cast, pose: Pose, y: number): string {
  return cast[pose]
    ? `<use href="#k${pose}" x="0" y="${y + 3}" width="${ART_W}" height="${ART_H}"/>`
    : `<circle fill="#d97757" cx="6" cy="${y + 12}" r="4.5"/>`
}
const artWidth = (cast: Cast) => (Object.keys(cast).length ? ART_W : 12)

// The clips a drawing uses, each once.
function castDefs(cast: Cast, poses: Pose[]): string {
  return [...new Set(poses)].map(p => cast[p]).filter(c => c !== undefined).map(c => `<style>${c.style}</style><defs>${c.symbol}</defs>`).join('')
}

const shortModel = (id: string) => fmtModel(id).replace(/ 1M$/, '')

// One subagent on two lines: Clawd in the pose of what it does (or a dot), what it does and on
// which model; beneath, a real bar when the agent reports its steps, else an indeterminate one
// with its latest action; once it ends, how it ended.
function agentRow(a: AgentRow, cast: Cast, W: number, y: number): string {
  const x = artWidth(cast) + 10
  const model = shortModel(a.model)
  const meta = `${a.type} · ${model}`
  const barW = Math.round(Math.min(140, Math.max(80, W * 0.16)))
  const by = y + 24
  let second: string
  if (a.status !== 'running') {
    const ok = a.status === 'done'
    second = capsule(`a${y}`, x, by, barW, 5, `<rect class="${ok ? 'g' : 'r'}" x="${x}" y="${by}" width="${barW}" height="5"/>`) +
      `<text class="s" x="${x + barW + 10}" y="${by + 5.5}" font-size="11.5">${ok ? 'done' : 'failed'} · ${a.steps} step${a.steps === 1 ? '' : 's'}</text>`
  } else if (a.stepTotal) {
    const done = a.stepDone ?? 0
    const fillW = Math.max(done ? 5 : 0, (barW * done) / a.stepTotal)
    second = capsule(`a${y}`, x, by, barW, 5, `<rect fill="#d97757" x="${x}" y="${by}" width="${fillW.toFixed(1)}" height="5"/>`) +
      `<text class="s" x="${x + barW + 10}" y="${by + 5.5}" font-size="11.5">${xml(fit(`${done}/${a.stepTotal}${a.stepNote ? ` · ${a.stepNote}` : ''}`, 11.5, W - x - barW - 10))}</text>`
  } else {
    // Indeterminate: a short segment sliding along the track, like a macOS progress bar.
    second = capsule(`a${y}`, x, by, barW, 5, `<rect class="slide" fill="#d97757" x="${x}" y="${by}" width="${Math.round(barW * 0.3)}" height="5"/>`) +
      `<text class="s" x="${x + barW + 10}" y="${by + 5.5}" font-size="11.5">${xml(fit(`${a.lastAction ?? 'starting'} · ${a.steps} step${a.steps === 1 ? '' : 's'}`, 11.5, W - x - barW - 10))}</text>`
  }
  return art(cast, agentPose(a), y) +
    `<text class="l" x="${x}" y="${y + 14}" font-size="13">${xml(fit(a.description || a.type, 13, W - x - textWidth(meta, 12) - 24))}</text>` +
    `<text class="s" x="${W}" y="${y + 14}" font-size="12" text-anchor="end">${xml(meta)}</text>` +
    second
}

// What the main loop's second line says, by its mood.
export function mainStatus(m: MainRow): string {
  switch (m.mood) {
    case 'working': return `${m.action ?? 'thinking'} · ${m.tools} tool${m.tools === 1 ? '' : 's'}`
    case 'stopped': return 'interrupted'
    case 'needs': return 'needs you'
    case 'agents': return `waiting on ${m.waitingOn} agent${m.waitingOn === 1 ? '' : 's'}`
    case 'idle': return 'waiting for you'
  }
}

// The main loop, first in the agents section: Clawd in the pose of its mood, what it last did
// and on which model; beneath, a bar that slides while it works.
function mainRow(m: MainRow, cast: Cast, W: number, y: number): string {
  const x = artWidth(cast) + 10
  const meta = `main · ${shortModel(m.model)}${m.effort ? ` ${m.effort}` : ''}`
  const barW = Math.round(Math.min(140, Math.max(80, W * 0.16)))
  const by = y + 24
  const status = mainStatus(m)
  const fill = m.isBusy ? `<rect class="slide" fill="#d97757" x="${x}" y="${by}" width="${Math.round(barW * 0.3)}" height="5"/>` : ''
  return art(cast, mainPose(m), y) +
    `<text class="l" x="${x}" y="${y + 14}" font-size="13" font-weight="600">main</text>` +
    `<text class="s" x="${W}" y="${y + 14}" font-size="12" text-anchor="end">${xml(meta)}</text>` +
    capsule(`m${y}`, x, by, barW, 5, fill) +
    `<text class="s" x="${x + barW + 10}" y="${by + 5.5}" font-size="11.5">${xml(fit(status, 11.5, W - x - barW - 10))}</text>`
}

const AGENT_ROW = 38
export const MAX_AGENTS = 2


const pctClass = (pct: number) => (pct >= 90 ? 'r' : pct >= 75 ? 'o' : 'l')

// A rounded track with its fill: the shape every bar on the dashboard shares.
function capsule(id: string, x: number, y: number, w: number, h: number, fills: string): string {
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/></clipPath>` +
    `<rect class="tr" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/><g clip-path="url(#${id})">${fills}</g>`
}

// The window split by category, like the storage bar in About This Mac.
function windowBar(snap: ContextSnapshot, id: string, x: number, y: number, w: number, h: number): string {
  let at = x
  const fills = segments(snap, 1000)
    .map(sg => {
      const sw = (sg.cells / 1000) * w
      const paint = sg.key === 'free' ? 'class="tr"' : sg.key === 'buffer' ? 'class="bf"' : `fill="${catColor(sg.key)}"`
      const r = `<rect ${paint} x="${at.toFixed(1)}" y="${y}" width="${sw.toFixed(1)}" height="${h}"/>`
      at += sw
      return r
    })
    .join('')
  return capsule(id, x, y, w, h, fills)
}

// Context  [segmented capsule]  36% · 356k of 1M · Opus 5.5 high
function contextRow(snap: ContextSnapshot, info: RunInfo | null, W: number, y: number, withLabel = true): string {
  const pct = usedPercent(snap)
  const rest = ` · ${fmtTokens(snap.used)} of ${fmtTokens(snap.max)}${info ? ` · ${fmtModel(info.model)}${info.effort ? ` ${info.effort}` : ''}` : ''}`
  const rightW = textWidth(`${pct}%${rest}`, 12.5)
  const barX = withLabel ? 66 : 0
  // The system font runs wider than the estimate, the bold percent most: leave room.
  const barW = Math.max(60, W - barX - rightW * 1.18 - 28)
  return (withLabel ? `<text class="s" x="0" y="${y + 16}" font-size="13" font-weight="500">Context</text>` : '') +
    windowBar(snap, `w${y}`, barX, y + 8, barW, 8) +
    `<text x="${W}" y="${y + 16}" font-size="12.5" text-anchor="end"><tspan class="${pctClass(pct)}" font-weight="600">${pct}%</tspan><tspan class="s">${xml(rest)}</tspan></text>`
}

function glyph(g: Goal, isActive: boolean, cx: number, cy: number): string {
  if (g.status === 'done') {
    return `<circle class="g" cx="${cx}" cy="${cy}" r="6"/><path d="M${cx - 3} ${cy}l2 2.2 4-4.4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  }
  if (isActive) return `<circle class="b" cx="${cx}" cy="${cy}" r="4.5"/>`
  return `<circle class="ring${g.status === 'parked' ? ' dash' : ''}" cx="${cx}" cy="${cy}" r="4"/>`
}

// Legend: dot, name, tokens, flowing onto as many lines as it needs. Returns the y of its last line.
function legend(snap: ContextSnapshot, W: number, y: number, parts: string[]): number {
  let x = 0
  const items = snap.rows.filter(r => r.tokens > 0).map(r => ({ dot: `fill="${catColor(r.label)}"`, name: r.label, value: fmtTokens(r.tokens) }))
  items.push({ dot: 'class="tr"', name: 'free', value: fmtTokens(snap.free) })
  for (const it of items) {
    const w = 14 + textWidth(`${it.name} ${it.value}`, 12) + 18
    if (x > 0 && x + w > W) {
      x = 0
      y += 20
    }
    parts.push(`<circle ${it.dot} cx="${x + 4}" cy="${y + 10}" r="4"/><text x="${x + 13}" y="${y + 14}" font-size="12"><tspan class="s">${xml(it.name)} </tspan><tspan class="l">${it.value}</tspan></text>`)
    x += w
  }
  return y
}

const ROW = 26

// ● Title ……………………  [capsule]  60%   (and, in the panel, the turns beneath)
function goalRow(g: Goal, isActive: boolean, W: number, y: number, withMeta: boolean): string {
  const barW = Math.round(Math.min(180, Math.max(80, W * 0.2)))
  const barX = W - 42 - barW
  const title = fit(g.title, 13, barX - 22 - 12)
  const fillCls = g.status === 'done' ? 'g' : g.status === 'parked' ? 't' : isActive ? 'b' : 'b dim'
  const fillW = g.progress > 0 ? Math.max(5, (barW * g.progress) / 100) : 0
  const meta = withMeta
    ? `<text class="s" x="22" y="${y + 33}" font-size="11.5">${g.turns} turn${g.turns === 1 ? '' : 's'} · since turn ${g.firstTurn}${g.status === 'parked' ? ' · parked' : ''}</text>`
    : ''
  return glyph(g, isActive, 6, y + 13) +
    `<text class="${g.status === 'done' ? 's' : 'l'}" x="22" y="${y + 17}" font-size="13" font-weight="${isActive ? 600 : 400}">${xml(title)}</text>` +
    capsule(`g${y}`, barX, y + 10.5, barW, 5, `<rect class="${fillCls}" x="${barX}" y="${y + 10.5}" width="${fillW.toFixed(1)}" height="5"/>`) +
    `<text class="s" x="${W}" y="${y + 17}" font-size="12" text-anchor="end">${g.progress}%</text>` +
    meta
}

function attentionRow(text: string, W: number, y: number): string {
  return `<circle class="o" cx="6" cy="${y + 12}" r="4.5"/>` +
    `<text class="l" x="22" y="${y + 16.5}" font-size="13">${xml(fit(text, 13, W - 22))}</text>`
}

function noteRow(text: string, cls: string, W: number, y: number, x = 22): string {
  return `<text class="${cls}" x="${x}" y="${y + 15}" font-size="12">${xml(fit(text, 12, W - x))}</text>`
}

function header(text: string, y: number): string {
  return `<text class="t" x="0" y="${y + 14}" font-size="11" font-weight="600" letter-spacing="0.6">${xml(text.toUpperCase())}</text>`
}

// The goals in the band: open ones first (the active one leads), done ones folded into a line.
export function openGoals(n: Note): { shown: Goal[]; more: number; done: number } {
  const active = activeGoal(n)
  const open = n.goals.filter(g => g.status !== 'done').sort((a, b) => (a.id === active?.id ? -1 : b.id === active?.id ? 1 : 0))
  return { shown: open.slice(0, 3), more: Math.max(0, open.length - 3), done: n.goals.length - open.length }
}

// The line under the open goals: how many more are open, and the finished ones by title, latest first.
export function foldedLine(n: Note, more: number): string {
  const done = n.goals.filter(g => g.status === 'done').reverse()
  return [more ? `+${more} more open` : '', done.length ? `${done.length} done: ${done.map(g => g.title).join(', ')}` : ''].filter(Boolean).join(' · ')
}

// What needs the person: the model's list, and a nudge when a second goal is open.
export function attention(n: Note, ctx: number | null): string[] {
  const items = [...n.waiting]
  const open = n.goals.filter(g => g.status !== 'done').length
  if (verdict(n, ctx).level === 'warn') items.push(`${open > 1 ? `${open} open goals` : `${n.goals.length} goals`} · start a new session for the next one`)
  return items
}

export type Drawing = { source: string; height: number; alt: string }

// The band above the prompt. `isIdle` hides what needs the person while Claude works.
// What the band shows, trimmed to fit the rows it has: past them the app scrolls it.
export type Plan = { legend: boolean; headers: boolean; goals: number; folded: boolean; main: boolean; agents: number; needs: number }

// The height of each kind of row, in the surface's unit (pixels on desktop, lines on the terminal).
export type Units = { context: number; legend: number; header: number; goal: number; note: number; agent: number; need: number }

export const DESKTOP_UNITS: Units = { context: 26, legend: 26, header: 22, goal: 26, note: 22, agent: 38, need: 24 }
export const TERMINAL_UNITS: Units = { context: 1, legend: 1, header: 1, goal: 1, note: 1, agent: 2, need: 1 }

// Drops what matters least until the band fits `budget`: the legend, the section titles, the
// folded goals line, then all but one goal, the main loop's row, all but one agent and one need,
// then the agents to a count. The context row always stays.
export function fitPlan(want: { hasContext: boolean; goals: number; folded: boolean; main: boolean; agents: number; needs: number }, budget: number, u: Units): Plan {
  const p: Plan = { legend: want.hasContext, headers: true, goals: want.goals, folded: want.folded, main: want.main, agents: want.agents, needs: want.needs }
  const height = () => {
    const sections = (p.goals || p.folded ? 1 : 0) + (want.agents || p.main ? 1 : 0) + (p.needs ? 1 : 0)
    return (want.hasContext ? u.context : 0) + (p.legend ? u.legend : 0) + (p.headers ? sections * u.header : 0) +
      p.goals * u.goal + (p.folded ? u.note : 0) + (p.main ? u.agent : 0) + p.agents * u.agent + (want.agents > p.agents ? u.note : 0) + p.needs * u.need
  }
  const steps: (() => void)[] = [
    () => { p.legend = false },
    () => { p.headers = false },
    () => { p.folded = false },
    () => { p.goals = Math.min(p.goals, 1) },
    () => { p.main = false },
    () => { p.agents = Math.min(p.agents, 1) },
    () => { p.needs = Math.min(p.needs, 1) },
    () => { p.agents = 0 },
    () => { p.goals = 0 },
  ]
  for (const step of steps) {
    if (height() <= budget) break
    step()
  }
  return p
}

// What there is to show, before any trimming.
export function wants(snap: ContextSnapshot | null, n: Note | null, ctx: number | null, agents: AgentRow[], isIdle: boolean, hasMain = false) {
  const g = n ? openGoals(n) : { shown: [], more: 0, done: 0 }
  // The agents on stage: running, or ended a moment ago (the caller picks them).
  const onStage = agents.length
  return {
    hasContext: snap !== null,
    goals: Math.min(3, g.shown.length + g.more),
    folded: g.more > 0 || g.done > 0,
    // The main loop always heads the agents section, its subagents or none.
    main: hasMain,
    agents: Math.min(MAX_AGENTS, onStage),
    needs: n && isIdle ? attention(n, ctx).length : 0,
  }
}

// `agents` are those on stage: running, or ended a moment ago.
export function bandSvg(snap: ContextSnapshot | null, info: RunInfo | null, n: Note | null, ctx: number | null, W: number, isIdle: boolean, agents: AgentRow[] = [], cast: Cast = {}, plan?: Plan, main: MainRow | null = null): Drawing {
  const want = wants(snap, n, ctx, agents, isIdle, main !== null)
  const p: Plan = plan ?? { legend: true, headers: true, goals: want.goals, folded: want.folded, main: want.main, agents: want.agents, needs: want.needs }
  const parts: string[] = []
  const alt: string[] = []
  let y = 0
  if (snap) {
    parts.push(contextRow(snap, info, W, y))
    alt.push(`Context ${usedPercent(snap)}%`)
    y += ROW
    if (p.legend) y = legend(snap, W, y, parts) + 26
  }
  if (n) {
    const active = activeGoal(n)
    const open = n.goals.filter(g => g.status !== 'done').sort((a, b) => (a.id === active?.id ? -1 : b.id === active?.id ? 1 : 0))
    const shown = open.slice(0, p.goals)
    const more = open.length - shown.length
    const done = n.goals.length - open.length
    if (p.headers && (shown.length || (p.folded && done))) {
      parts.push(header('Goals', y))
      y += 20
    }
    for (const g of shown) {
      parts.push(goalRow(g, g.id === active?.id, W, y, false))
      alt.push(`${g.title} ${g.progress}%`)
      y += ROW
    }
    const folded = foldedLine(n, more)
    if (p.folded && folded) {
      parts.push(noteRow(folded, 's', W, y))
      y += 22
    }
  }
  const showsMain = p.main && main !== null
  if ((agents.length || showsMain) && p.headers) {
    parts.push(header('Agents', y + 4))
    y += 24
  }
  if (showsMain) {
    parts.push(mainRow(main, cast, W, y))
    alt.push(`Main: ${mainStatus(main)}`)
    y += AGENT_ROW
  }
  const shown = agents.slice(0, p.agents)
  for (const a of shown) {
    parts.push(agentRow(a, cast, W, y))
    alt.push(`Agent: ${a.description || a.type}${a.status === 'running' ? '' : ` (${a.status})`}`)
    y += AGENT_ROW
  }
  if (agents.length > p.agents) {
    const rest = agents.length - p.agents
    parts.push(noteRow(`${p.agents ? `+${rest} more` : `${rest}`} agent${rest === 1 ? '' : 's'} running · /agents-info`, 's', W, y, p.agents ? 22 : 0))
    y += 22
  }
  const needs = n && isIdle ? attention(n, ctx) : []
  if (needs.length && p.needs) {
    if (p.headers) {
      parts.push(header('Needs you', y + 4))
      y += 24
    }
    for (const a of needs.slice(0, p.needs)) {
      parts.push(attentionRow(a, W, y))
      alt.push(`Needs you: ${a}`)
      y += 24
    }
    if (needs.length > p.needs) alt.push(`${needs.length - p.needs} more need you`)
  }
  const height = Math.max(ROW, y + 2)
  const defs = castDefs(cast, [...(showsMain ? [mainPose(main)] : []), ...shown.map(agentPose)])
  return { source: svg(W, height, parts.join(''), defs), height, alt: alt.join('; ') }
}

// One line: a small window bar, the active goal and how many things need the person.
export function compactSvg(snap: ContextSnapshot | null, n: Note | null, ctx: number | null, W: number, isIdle: boolean): Drawing {
  const parts: string[] = []
  let x = 0
  const y = 0
  if (snap) {
    const pct = usedPercent(snap)
    parts.push(windowBar(snap, 'cw', x, 9, 90, 7), `<text class="${pctClass(pct)}" x="${x + 98}" y="16" font-size="12.5" font-weight="600">${pct}%</text>`)
    x += 140
  }
  const g = n ? activeGoal(n) : undefined
  const needs = n && isIdle ? attention(n, ctx).length : 0
  if (g) {
    const room = W - x - (needs ? 120 : 0) - 120
    parts.push(
      glyph(g, true, x + 6, 13),
      `<text class="l" x="${x + 18}" y="17" font-size="13" font-weight="600">${xml(fit(g.title, 13, Math.max(40, room)))}</text>`,
    )
    const bx = x + 18 + Math.min(textWidth(g.title, 13), Math.max(40, room)) + 12
    parts.push(capsule('cg', bx, 10.5, 70, 5, `<rect class="b" x="${bx}" y="10.5" width="${((70 * g.progress) / 100).toFixed(1)}" height="5"/>`))
    parts.push(`<text class="s" x="${bx + 78}" y="17" font-size="12">${g.progress}%</text>`)
  }
  if (needs) {
    const label = `${needs} need${needs === 1 ? 's' : ''} you`
    parts.push(`<circle class="o" cx="${W - textWidth(label, 12.5) - 12}" cy="${y + 13}" r="4.5"/><text class="l" x="${W}" y="17" font-size="12.5" text-anchor="end">${label}</text>`)
  }
  return { source: svg(W, ROW, parts.join('')), height: ROW, alt: [snap ? `Context ${usedPercent(snap)}%` : '', g ? `${g.title} ${g.progress}%` : '', needs ? `${needs} need you` : ''].filter(Boolean).join('; ') }
}

// The panel: every section, headed, with the detail the band leaves out.
// `agents` are all of the session's; `stage` those to draw: running, or ended a moment ago.
export function paneSvg(snap: ContextSnapshot | null, info: RunInfo | null, n: Note | null, ctx: number | null, W: number, agents: AgentRow[] = [], stage: AgentRow[] = [], cast: Cast = {}, main: MainRow | null = null): Drawing {
  const parts: string[] = []
  let y = 0
  if (snap) {
    parts.push(header('Context', y))
    y += 24
    parts.push(contextRow(snap, info, W, y, false))
    y += ROW + 4
    y = legend(snap, W, y, parts)
    y += 24
    const facts = [snap.compactsAt !== null ? `compacts at ${fmtPct(snap.compactsAt, snap.max)}` : '', snap.costUsd !== null ? `${fmtUsd(snap.costUsd)} this session` : ''].filter(Boolean).join(' · ')
    if (facts) {
      parts.push(noteRow(facts, 's', W, y, 0))
      y += 22
    }
    y += 8
  }
  if (n) {
    const active = activeGoal(n)
    parts.push(header(`Goals · ${n.goals.length}`, y))
    y += 24
    for (const g of n.goals) {
      parts.push(goalRow(g, g.id === active?.id, W, y, true))
      y += 40
    }
    const needs = attention(n, ctx)
    if (needs.length) {
      y += 4
      parts.push(header('Needs you', y))
      y += 24
      for (const a of needs) {
        parts.push(attentionRow(a, W, y))
        y += 24
      }
    }
    if (n.now) {
      y += 4
      parts.push(header('Now', y))
      y += 22
      parts.push(noteRow(n.now, 'l', W, y, 0))
      y += 20
      for (const b of n.bullets.slice(0, 4)) {
        parts.push(noteRow(`·  ${b}`, 's', W, y, 0))
        y += 20
      }
    }
    y += 8
  }
  const running = agents.filter(a => a.status === 'running')
  const finished = agents.length - running.length
  if (agents.length || main) {
    parts.push(header(`Agents · ${running.length} running${finished ? ` · ${finished} done` : ''}`, y))
    y += 24
    if (main) {
      parts.push(mainRow(main, cast, W, y))
      y += AGENT_ROW
    }
    for (const a of stage) {
      parts.push(agentRow(a, cast, W, y))
      y += AGENT_ROW
    }
  }
  if (!snap && !n) parts.push(noteRow('Measuring the session…', 's', W, 0, 0))
  const height = Math.max(ROW, y + 4)
  const defs = castDefs(cast, [...(main ? [mainPose(main)] : []), ...stage.map(agentPose)])
  return { source: svg(W, height, parts.join(''), defs), height, alt: 'Dashboard: context, goals, agents and what needs you' }
}
