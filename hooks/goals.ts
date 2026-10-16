import type { Exchange, Goal, Note } from '../types'

export const KEEP = 8

export const SYSTEM = `You keep a tiny "where am I" note for a person working with Claude Code, a coding agent, in one session.
From the earlier note and the latest exchanges, reply with JSON only, no prose, no code fence:
{"goals":[{"id":"g1","title":"...","progress":0-100,"status":"active|done|parked"}],"active":"g1","now":"...","waiting":["...","..."],"bullets":["...","..."]}
Rules:
- goals: every distinct objective the session has pursued so far, in order of appearance. Keep the earlier ids and titles; never renumber, never drop one.
- A NEW goal is a new objective unrelated to the earlier ones (a different feature, bug, repo or topic). A sub-step, a fix, a follow-up question or a retry of the same objective is NOT a new goal. Be conservative: most sessions have one goal.
- progress: 0 = just stated, 100 = finished and confirmed (shipped, merged, the person said it is done). Move it with evidence; it may go down when the person reopens the work.
- status: "done" at 100 or when the person moved on after finishing; "parked" when they set it aside unfinished; else "active".
- active: the id the latest exchanges worked on.
- now: what Claude Code just did or is doing, under 20 words.
- waiting: the things waiting on the person's attention right now (a question to answer, a decision, a command to run, something to check), 0 to 3 items, each an imperative phrase under 12 words; [] when nothing waits. Drop an item once the person has handled it.
- bullets: 2 to 4 short bullets on where the active goal stands.
Write titles, now, waiting and bullets in English, whatever language the person writes in. Titles are short: under 6 words.`

export const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text

export const tail = (text: string, max: number) =>
  text.length > max ? `…${text.slice(-max)}` : text

export function describeTool(tool: string, input: unknown): string {
  const fields = (input ?? {}) as Record<string, unknown>
  const detail = ['description', 'command', 'file_path', 'pattern', 'url', 'query', 'prompt']
    .map(name => fields[name])
    .find(value => typeof value === 'string')
  return detail ? `${tool}: ${clip(String(detail), 80)}` : tool
}

export function toPrompt(earlier: Note | null, exchanges: Exchange[]): string {
  const note = earlier
    ? `Earlier note:\n${JSON.stringify({
        goals: earlier.goals.map(g => ({ id: g.id, title: g.title, progress: g.progress, status: g.status })),
        active: earlier.activeId,
        now: earlier.now,
        waiting: earlier.waiting,
      })}`
    : 'Earlier note: none (new session).'
  const turns = exchanges
    .map(
      (one, i) =>
        `--- exchange ${i + 1}\nPerson: ${clip(one.prompt, 600)}\nTools: ${one.tools.join('; ') || 'none'}\nClaude Code: ${tail(one.answer, 1200) || '(no text)'}`,
    )
    .join('\n')
  return `${note}\n\nLatest exchanges, oldest first:\n${turns}`
}

type RawGoal = { id?: unknown; title?: unknown; progress?: unknown; status?: unknown }

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const pct = (value: unknown) => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
}

// Folds the model's reply into the earlier note: ids and first-seen turns survive, counts move.
export function parse(text: string, earlier: Note | null, turn: number): Note | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const rawGoals = Array.isArray(raw.goals) ? (raw.goals as RawGoal[]) : []
  const before = new Map((earlier?.goals ?? []).map(g => [g.id, g] as const))
  const goals: Goal[] = []
  let n = 0
  for (const rg of rawGoals) {
    const title = str(rg.title)
    if (!title) continue
    n += 1
    const id = str(rg.id) || `g${n}`
    const was = before.get(id)
    const status = (['active', 'done', 'parked'] as const).find(s => s === str(rg.status)) ?? 'active'
    goals.push({
      id,
      title: was?.title ?? title,
      progress: status === 'done' ? 100 : pct(rg.progress),
      status,
      firstTurn: was?.firstTurn ?? turn,
      turns: was?.turns ?? 0,
    })
  }
  // A goal the reply forgot still exists: carry it over unchanged.
  for (const g of before.values()) if (!goals.some(x => x.id === g.id)) goals.push(g)
  if (goals.length === 0) return null

  const activeId = goals.some(g => g.id === str(raw.active)) ? str(raw.active) : goals.find(g => g.status === 'active')?.id ?? goals[goals.length - 1]!.id
  for (const g of goals) if (g.id === activeId) g.turns += 1

  const bullets = Array.isArray(raw.bullets) ? raw.bullets.map(str).filter(Boolean).slice(0, 5) : []
  // An older reply gives one string; the current shape a list.
  const waiting = (Array.isArray(raw.waiting) ? raw.waiting.map(str) : [str(raw.waiting)]).filter(Boolean).slice(0, 3)
  return { goals, activeId, now: str(raw.now), waiting, bullets, turn }
}

export const activeGoal = (note: Note): Goal | undefined =>
  note.goals.find(g => g.id === note.activeId) ?? note.goals[note.goals.length - 1]

export function bar(progress: number, cells: number): string {
  const full = Math.round((progress / 100) * cells)
  return '▓'.repeat(full) + '░'.repeat(Math.max(0, cells - full))
}

export type Verdict = { level: 'ok' | 'notice' | 'warn'; text: string }

// Whether to suggest a fresh session: more than one goal, weighted by how full the window is.
export function verdict(note: Note, contextPct: number | null): Verdict {
  const open = note.goals.filter(g => g.status !== 'done').length
  const total = note.goals.length
  if (total <= 1) return { level: 'ok', text: '' }
  const ctx = contextPct === null ? '' : ` · ctx ${contextPct}%`
  if (open >= 2 || (contextPct ?? 0) >= 50) {
    return { level: 'warn', text: `⚠ ${total} goals${ctx} → open a new session for the next one` }
  }
  return { level: 'notice', text: `${total} goals this session${ctx}` }
}

export function asText(note: Note, contextPct: number | null): string {
  const lines: string[] = []
  for (const g of note.goals) {
    const mark = g.id === note.activeId ? '▶' : g.status === 'done' ? '✔' : g.status === 'parked' ? '◌' : '·'
    lines.push(`${mark} ${g.id} ${bar(g.progress, 10)} ${g.progress}%  ${g.title}  (${g.turns} turn${g.turns === 1 ? '' : 's'}, from turn ${g.firstTurn})`)
  }
  if (note.now) lines.push(`now: ${note.now}`)
  for (const b of note.bullets) lines.push(`• ${b}`)
  for (const w of note.waiting) lines.push(`Needs you: ${w}`)
  const v = verdict(note, contextPct)
  if (v.text) lines.push(v.text)
  return lines.join('\n')
}
