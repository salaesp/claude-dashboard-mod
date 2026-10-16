import { atom, read, update } from 'claude-code'
import type { BoxProps, ElementConstructor, EngineInterface, Register, TextProps } from 'claude-code'

import type { AgentRow, ContextSnapshot, DashMode, Exchange, MainMood, MainRow, Note, RunInfo } from '../types'
import { fmtEffort, fmtModel, fmtTokens, groupSmall, pushReading, segments, toSnapshot, usedPercent } from './context'
import type { Cast, Plan, Pose } from './draw'
import { DESKTOP_UNITS, MAX_AGENTS, POSES, TERMINAL_UNITS, attention, bandSvg, catColor, compactSvg, fitPlan, foldedLine, mainStatus, paneSvg, wants } from './draw'
import { clipSymbol, every, parseSprites } from './sprites'
import { KEEP, SYSTEM, activeGoal, asText, clip, describeTool, parse, toPrompt, verdict } from './goals'

const snapshot = atom({ plugin: 'dashboard', key: 'snapshot' } as const, null as ContextSnapshot | null)
const run = atom({ plugin: 'dashboard', key: 'run' } as const, null as RunInfo | null)
const history = atom({ plugin: 'dashboard', key: 'history' } as const, [] as number[])
const note = atom({ plugin: 'dashboard', key: 'note' } as const, null as Note | null)
const log = atom({ plugin: 'dashboard', key: 'log' } as const, [] as Exchange[])
const mode = atom({ plugin: 'dashboard', key: 'mode' } as const, 'full' as DashMode)
const isHidden = atom({ plugin: 'dashboard', key: 'isHidden' } as const, false)

const agents = atom({ plugin: 'dashboard', key: 'agents' } as const, [] as AgentRow[])
const busy = atom({ plugin: 'dashboard', key: 'busy' } as const, false)
const paneUp = atom({ plugin: 'dashboard', key: 'paneUp' } as const, false)
const stopped = atom({ plugin: 'dashboard', key: 'stopped' } as const, false)

const PANE = { id: 'dashboard', title: 'Dashboard' }

// Clawd in every pose, from clawd-desk's cache of the desktop app's sprites. Module scope:
// session.start reads it again on every (re)load; without the cache the rows show a dot.
// Desktop only: the terminal keeps to text marks.
let cast: Cast = {}

async function loadClawd($: EngineInterface) {
  const home = await $.env.get('HOME')
  if (!home) return
  const sprites = parseSprites(await $.fs.read(`${home}/.claude/clawd-desk/sprites.cache.js`))
  const next: Cast = {}
  for (const [pose, p] of Object.entries(POSES) as [Pose, (typeof POSES)[Pose]][]) {
    const s = sprites[p.sprite]
    if (!s) continue
    const frames = every(p.from, Math.min(p.to, s.frames.length - 1), p.step)
    // At the sprites' own 12 fps: each frame kept stands for `step` of them.
    next[pose] = { ...clipSymbol(s, `k${pose}`, frames, (frames.length * p.step) / 12), w: s.w, h: s.h }
  }
  cast = next
}

// How long a finished agent stays on stage, to show how it ended.
const LINGER_MS = 3000

// The agents a drawing shows: running, or ended within LINGER_MS.
async function onStage($: EngineInterface): Promise<AgentRow[]> {
  const now = await $.clock.now().catch(() => 0)
  return (await read($, agents)).filter(a => a.status === 'running' || (a.endedAt !== undefined && now - a.endedAt < LINGER_MS))
}

// What the main loop's row says: its model, its latest tool this turn, and its mood, most
// pressing first: working, interrupted, waiting on the person, on its agents, or idle.
async function mainRow($: EngineInterface, isBusy: boolean): Promise<MainRow | null> {
  const info = await read($, run)
  if (!info) return null
  const last = (await read($, log)).at(-1)
  const tools = last && !last.answer ? last.tools : []
  const n = await read($, note)
  const waitingOn = (await read($, agents)).filter(a => a.status === 'running').length
  const mood: MainMood = isBusy
    ? 'working'
    : (await read($, stopped))
      ? 'stopped'
      : n && attention(n, await contextPct($)).length
        ? 'needs'
        : waitingOn
          ? 'agents'
          : 'idle'
  return { model: info.model, effort: info.effort, action: tools.at(-1) ?? null, tools: tools.length, isBusy, mood, waitingOn }
}

// --- context: the window's fill, by category, and the model the main loop asks.

async function refreshContext($: EngineInterface) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (b) {
    // Categories under 4k tokens fold into one "others" row.
    const snap = groupSmall(toSnapshot(b, usage.cost?.usd ?? null))
    await update($, snapshot, () => snap)
    await update($, history, prev => pushReading(prev ?? [], snap.used))
  }
}

async function seedModel($: EngineInterface) {
  const model = await $.session.model()
  await update($, run, prev => prev ?? { model, effort: null })
}

const contextPct = async ($: EngineInterface): Promise<number | null> => {
  const snap = await read($, snapshot)
  return snap ? usedPercent(snap) : null
}

// --- goals: one cheap model call per turn keeps a note of the session's goals.

// The latest refresh, so /dashboard text can wait for it rather than show a stale note.
let pending: Promise<void> = Promise.resolve()
let generation = 0
let turn = 0

async function refreshGoals($: EngineInterface) {
  const mine = ++generation
  // The turn this note is written after, fixed now: a prompt may land while the model answers.
  const at = turn
  const exchanges = await read($, log)
  if (exchanges.length === 0) return
  const earlier = await read($, note)

  const r = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: toPrompt(earlier, exchanges),
    maxTokens: 700,
    effort: 'low',
    timeoutMs: 30_000,
  })
  const fresh = r.isAnswered ? parse(r.text, earlier, at) : null
  if (!fresh || mine !== generation) return
  await update($, note, () => fresh)

  const before = earlier?.goals.length ?? 0
  if (fresh.goals.length > before && before > 0) {
    const g = fresh.goals[fresh.goals.length - 1]!
    const warn = verdict(fresh, await contextPct($)).level === 'warn'
    $.ui.toast(`New goal: ${clip(g.title, 40)}${warn ? ' · consider a new session' : ''}`, { timeoutMs: 8000 })
  }
}

// --- terminal: the same rows in text, colored by the person's theme.

type Kit = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps> }

const thin = (progress: number, cells: number) => {
  const filled = Math.max(0, Math.min(cells, Math.round((progress / 100) * cells)))
  return ['━'.repeat(filled), '─'.repeat(cells - filled)] as const
}

function contextLine({ Text }: Kit, snap: ContextSnapshot, info: RunInfo | null, columns: number) {
  const pct = usedPercent(snap)
  const cells = Math.max(10, Math.min(30, columns - 50))
  return (
    <Text wrap="truncate">
      <Text color="subtle">{'Context  '}</Text>
      {segments(snap, cells).map(sg => (
        <Text color={sg.key === 'free' || sg.key === 'buffer' ? 'inactive' : catColor(sg.key)}>{(sg.key === 'free' || sg.key === 'buffer' ? '─' : '━').repeat(sg.cells)}</Text>
      ))}
      <Text bold color={pct >= 90 ? 'error' : pct >= 75 ? 'warning' : undefined}>{`  ${pct}%`}</Text>
      <Text color="subtle">{` · ${fmtTokens(snap.used)} of ${fmtTokens(snap.max)}${info ? ` · ${fmtModel(info.model)}${info.effort ? ` ${info.effort}` : ''}` : ''}`}</Text>
    </Text>
  )
}

function legendLine({ Box, Text }: Kit, snap: ContextSnapshot) {
  return (
    <Box flexWrap="wrap" columnGap={2}>
      {snap.rows.filter(r => r.tokens > 0).map(r => (
        <Text>
          <Text color={catColor(r.label)}>{'● '}</Text>
          <Text color="subtle">{`${r.label} `}</Text>
          <Text>{fmtTokens(r.tokens)}</Text>
        </Text>
      ))}
      <Text color="inactive">{`○ free ${fmtTokens(snap.free)}`}</Text>
    </Box>
  )
}

// The main loop first, then one line per agent on stage, like the goals: what it does, then its
// type and model; beneath, its steps, its latest action, or how it ended.
function agentLine({ Box, Text }: Kit, team: AgentRow[], max = MAX_AGENTS, main: MainRow | null = null) {
  if (!team.length && !main) return null
  const shown = team.slice(0, max)
  const head = main && (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color="claude">{'◆ '}</Text>
        <Text bold>main</Text>
        <Text color="subtle">{`  ${fmtModel(main.model)}${main.effort ? ` ${main.effort}` : ''}`}</Text>
      </Text>
      <Text wrap="truncate" color={main.mood === 'needs' ? 'warning' : 'subtle'}>{`  ${main.mood === 'working' ? '⋯ ' : ''}${mainStatus(main)}`}</Text>
    </Box>
  )
  if (!shown.length) {
    return (
      <Box flexDirection="column">
        {head}
        {team.length > 0 && <Text color="subtle">{`● ${team.length} agent${team.length === 1 ? '' : 's'} · /agents-info`}</Text>}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {head}
      {shown.map(a => {
        const [on, off] = a.stepTotal ? thin((100 * (a.stepDone ?? 0)) / a.stepTotal, 12) : ['', '']
        return (
          <Box flexDirection="column">
            <Text wrap="truncate">
              <Text color={a.status === 'done' ? 'success' : a.status === 'failed' ? 'error' : 'claude'}>{a.status === 'done' ? '✓ ' : a.status === 'failed' ? '✗ ' : '● '}</Text>
              <Text>{a.description || a.type}</Text>
              <Text color="subtle">{`  ${a.type} · ${fmtModel(a.model)}`}</Text>
            </Text>
            {a.status !== 'running' ? (
              <Text wrap="truncate" color="subtle">{`  ${a.status} · ${a.steps} step${a.steps === 1 ? '' : 's'}`}</Text>
            ) : a.stepTotal ? (
              <Text wrap="truncate">
                <Text>{'  '}</Text>
                <Text color="claude">{on}</Text>
                <Text color="inactive">{off}</Text>
                <Text color="subtle">{`  ${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ` · ${a.stepNote}` : ''}`}</Text>
              </Text>
            ) : (
              <Text wrap="truncate" color="subtle">{`  ⋯ ${a.lastAction ?? 'starting'} · ${a.steps} step${a.steps === 1 ? '' : 's'}`}</Text>
            )}
          </Box>
        )
      })}
      {team.length > shown.length && <Text color="subtle">{`  +${team.length - shown.length} more agents · /agents-info`}</Text>}
    </Box>
  )
}

function goalLines({ Text }: Kit, n: Note, columns: number, all: boolean, plan?: Plan) {
  const active = activeGoal(n)
  const open = n.goals.filter(g => g.status !== 'done').sort((a, b) => (a.id === active?.id ? -1 : b.id === active?.id ? 1 : 0))
  const shown = open.slice(0, plan ? plan.goals : 3)
  const more = open.length - shown.length
  const list = all ? n.goals : shown
  const titleCells = Math.max(12, Math.min(48, columns - 24))
  const lines = list.map(g => {
    const isActive = g.id === active?.id
    const [on, off] = thin(g.progress, 12)
    const mark = g.status === 'done' ? '✓' : isActive ? '●' : g.status === 'parked' ? '◌' : '○'
    const color = g.status === 'done' ? 'success' : isActive ? 'suggestion' : 'subtle'
    return (
      <Text wrap="truncate">
        <Text color={color}>{`${mark} `}</Text>
        <Text bold={isActive} color={g.status === 'done' ? 'subtle' : undefined}>{clip(g.title, titleCells - 1).padEnd(titleCells)}</Text>
        <Text color={color}>{on}</Text>
        <Text color="inactive">{off}</Text>
        <Text color="subtle">{`  ${String(g.progress).padStart(3)}%`}</Text>
      </Text>
    )
  })
  const folded = all || (plan && !plan.folded) ? '' : foldedLine(n, more)
  if (folded) lines.push(<Text color="subtle">{`  ${folded}`}</Text>)
  return lines
}

function attentionLines({ Text }: Kit, items: string[]) {
  return items.map(a => (
    <Text wrap="truncate">
      <Text color="warning">{'● '}</Text>
      <Text>{a}</Text>
    </Text>
  ))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dashboard',
      description: 'Dashboard panel: context, goals and what needs you; "text" prints the goals, "compact"/"full" size the band, "hide"/"show" toggle it',
      argumentHint: '[text|compact|full|hide|show]',
      immediate: true,
    })
    const saved = await $.store.get('mode').catch(() => undefined)
    if (saved === 'compact' || saved === 'full') await update($, mode, () => saved)
    turn = await $.session.turns().catch(() => 0)
    const ran = await next(e)
    void refreshContext($).catch(() => {})
    void seedModel($).catch(() => {})
    void loadClawd($).catch(() => {})
    return ran
  })

  // Subagents of the main loop: a row while each runs.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    const at = await $.clock.now().catch(() => 0)
    const row: AgentRow = {
      id: started.agentId ?? e.tool_use_id,
      agentId: started.agentId,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      status: 'running',
      startedAt: at,
      steps: 0,
    }
    await update($, agents, list => [...list.filter(a => a.id !== row.id), row].slice(-50))
    return started
  })

  // The panel shows all the band does: while it is up, the band steps aside.
  on('ui.open', { id: PANE.id }, async ($, e, next) => {
    const opened = await next(e)
    // A call's hooks see `{ value }`, or `{ deny }` when one refused it.
    const placed = (opened as { value?: { isPlaced?: boolean } }).value?.isPlaced === true
    await update($, paneUp, () => placed)
    return opened
  })

  on('ui.close', { id: PANE.id }, async ($, e, next) => {
    const closed = await next(e)
    await update($, paneUp, () => false)
    return closed
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      generation += 1
      turn = 0
      await update($, note, () => null)
      await update($, log, () => [])
      await update($, agents, () => [])
    }
    return next(e)
  })

  // Each main-loop request names the model and effort it is sent with. Subagents' are left out.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      void update($, agents, list => list.map(a => (a.agentId === agentId ? { ...a, steps: a.steps + 1, isThinking: true } : a))).catch(() => {})
    } else {
      const now = { model: e.model, effort: fmtEffort(e.effort) }
      void update($, run, prev => (prev?.model === now.model && prev.effort === now.effort ? prev : now)).catch(() => {})
      void read($, busy).then(was => (was ? undefined : update($, busy, () => true))).catch(() => {})
    }
    return yield* next(e)
  })

  // After each turn and whenever the fill or the cost moves (a compaction included).
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') || e.changed.includes('cost')) void refreshContext($).catch(() => {})
    return next(e)
  })

  // The phone draws no band above the prompt: it gets the panel.
  on('session.attach', { surface: 'mobile' }, async ($, e, next) => {
    const ran = await next(e)
    void $.ui.open(PANE).catch(() => {})
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    if (text && !text.startsWith('/') && e.origin.kind !== 'plugin') {
      await update($, stopped, () => false).catch(() => undefined)
      await update($, log, list => {
        const last = list.at(-1)
        // A prompt typed into a running turn belongs to that turn's exchange.
        if (e.turnId && last && !last.answer) {
          return [...list.slice(0, -1), { ...last, prompt: `${last.prompt}\n${text}` }]
        }
        turn += 1
        return [...list, { prompt: text, tools: [], answer: '' }].slice(-KEEP)
      }).catch(() => undefined)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const agentId = e.agentId
      if (e.tool === 'mcp__savvy-progress__step') {
        const input = e as unknown as { done?: number; total?: number; note?: string }
        await update($, agents, list =>
          list.map(a => {
            if (a.agentId !== agentId) return a
            const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
            const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
            return { ...a, stepTotal: total || undefined, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || a.stepNote }
          }),
        ).catch(() => undefined)
      } else {
        const line = describeTool(e.tool, e)
        await update($, agents, list => list.map(a => (a.agentId === agentId ? { ...a, lastAction: line, lastTool: e.tool, isThinking: false } : a))).catch(() => undefined)
      }
    } else {
      const line = describeTool(e.tool, e)
      await update($, log, list => {
        const last = list.at(-1)
        return last ? [...list.slice(0, -1), { ...last, tools: [...last.tools, line].slice(-12) }] : list
      })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) {
      const agentId = e.agentId
      const status = e.reason === 'answer' ? ('done' as const) : ('failed' as const)
      const endedAt = await $.clock.now().catch(() => 0)
      await update($, agents, list => list.map(a => (a.agentId === agentId ? { ...a, status, endedAt, isThinking: false } : a)))
      // Off stage once it has shown how it ended.
      $.clock.after(LINGER_MS + 50, () => $.ui.invalidate('ui.render'))
      return done
    }
    await update($, busy, () => false)
    await update($, stopped, () => e.isAborted)
    const answer = e.isAborted ? `${e.answer}\n(interrupted by the person)` : e.answer
    await update($, log, list => {
      const last = list.at(-1)
      return last ? [...list.slice(0, -1), { ...last, answer: answer.trim() }] : list
    })
    // Off the turn's path: the answer is not held up by the note.
    pending = refreshGoals($).catch(() => undefined)
    return done
  })

  on('command.run', { command: 'dashboard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide' || arg === 'show') {
      await update($, isHidden, () => arg === 'hide')
      return { text: arg === 'hide' ? 'Dashboard band hidden. /dashboard show brings it back.' : 'Dashboard band shown.' }
    }
    if (arg === 'compact' || arg === 'full') {
      await update($, mode, () => arg)
      await $.store.set('mode', arg)
      await update($, isHidden, () => false)
      return { text: `Dashboard band: ${arg}.` }
    }
    if (arg === 'text') {
      await pending
      const n = await read($, note)
      return { text: n ? asText(n, await contextPct($)) : 'No goals yet; they appear after the first answer.' }
    }
    if (arg !== '') return { text: `Unknown option "${arg}". Usage: /dashboard [text|compact|full|hide|show]` }
    await refreshContext($).catch(() => {})
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE.id)
    if (isOpen) {
      await $.ui.close({ id: PANE.id })
      return { text: 'Dashboard panel closed.' }
    }
    const opened = await $.ui.open({ ...PANE, focus: true })
    return { text: opened.isPlaced ? 'Dashboard panel opened.' : `Dashboard panel waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const n = await read($, note)
    // Loaded mid-session (a reload) nothing has been measured yet: measure now, the write redraws.
    if (!snap) void refreshContext($).catch(() => {})
    if ((await read($, run)) === null) void seedModel($).catch(() => {})
    const team = await onStage($)
    // An unload closes the panel without telling its hooks: the engine's record settles it.
    const isPaneUp = (await read($, paneUp)) && (await $.ui.panes()).some(p => p.id === PANE.id && p.isPlaced)
    if (e.props.hasSurvey || isPaneUp || (await read($, isHidden)) || (!snap && !n && !team.length)) return next(e)

    const ui = $.ui.resolve(e)
    const info = await read($, run)
    const ctx = snap ? usedPercent(snap) : null
    const isIdle = !e.props.isWorking
    const isCompact = (await read($, mode)) === 'compact'
    // The slot is shared: ours on top of what the plugins beneath draw.
    const below = await next(e)
    // Past `maxRows` the app scrolls the band: fit ours in what is left after the bands beneath
    // (a guess of two rows for them) and a row of slack. A desktop row is about 20 px.
    // The terminal's full band sits in a rounded frame: its top and bottom edges take two rows.
    const frame = !isCompact && (e.surface === 'terminal' || !('Svg' in ui)) ? 2 : 0
    const rows = Math.max(3, (e.props.maxRows || 12) - (below ? 2 : 0) - 1 - frame)
    // The main loop's row, once a request has named its model.
    const head = await mainRow($, !!e.props.isWorking)
    const want = wants(snap, n, ctx, team, isIdle, head !== null)
    const isTerminal = !(e.surface !== 'terminal' && 'Svg' in ui)
    const plan: Plan = isTerminal ? fitPlan(want, rows, TERMINAL_UNITS) : fitPlan(want, rows * 20, DESKTOP_UNITS)
    const main = plan.main ? head : null

    let mine
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      // About 8 CSS px per reported column; with no width the image takes its own, up to the slot.
      const W = Math.max(260, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 24))
      const d = isCompact ? compactSvg(snap, n, ctx, W, isIdle) : bandSvg(snap, info, n, ctx, W, isIdle, team, cast, plan, main)
      mine = <ui.Svg source={d.source} alt={d.alt} />
    } else {
      const kit = ui as Kit
      const cols = e.props.bodyColumns
      if (isCompact) {
        const g = n ? activeGoal(n) : undefined
        const needs = n && isIdle ? attention(n, ctx).length : 0
        mine = (
          <kit.Text wrap="truncate">
            {snap && <kit.Text color="subtle">{'Context '}</kit.Text>}
            {snap && <kit.Text bold>{`${usedPercent(snap)}%`}</kit.Text>}
            {g && <kit.Text color="suggestion">{'   ● '}</kit.Text>}
            {g && <kit.Text bold>{`${clip(g.title, 40)} `}</kit.Text>}
            {g && <kit.Text color="subtle">{`${g.progress}%`}</kit.Text>}
            {needs > 0 && <kit.Text color="warning">{`   ● ${needs} need${needs === 1 ? 's' : ''} you`}</kit.Text>}
          </kit.Text>
        )
      } else {
        // Framed, with the mod's name laid over the top edge so it says whose band this is.
        mine = (
          <kit.Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
            <kit.Box position="absolute" top={-1} left={1}>
              <kit.Text color="subtle">{' dashboard '}</kit.Text>
            </kit.Box>
            {snap && contextLine(kit, snap, info, cols - 4)}
            {snap && plan.legend && legendLine(kit, snap)}
            {n && plan.headers && (plan.goals > 0 || plan.folded) && <kit.Text color="subtle" bold>GOALS</kit.Text>}
            {n && goalLines(kit, n, cols - 4, false, plan)}
            {plan.headers && (main !== null || team.length > 0) && <kit.Text color="subtle" bold>AGENTS</kit.Text>}
            {agentLine(kit, team, plan.agents, main)}
            {n && plan.headers && plan.needs > 0 && <kit.Text color="subtle" bold>NEEDS YOU</kit.Text>}
            {n && isIdle && attentionLines(kit, attention(n, ctx).slice(0, plan.needs))}
          </kit.Box>
        )
      }
    }
    return (
      <ui.Box flexDirection="column">
        {mine}
        {below}
      </ui.Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE.id }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const n = await read($, note)
    const info = await read($, run)
    const ctx = snap ? usedPercent(snap) : null
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const W = Math.max(260, Math.min(1200, (e.props.bodyColumns || 60) * 8 - 16))
      const d = paneSvg(snap, info, n, ctx, W, await read($, agents), await onStage($), cast, await mainRow($, await read($, busy)))
      return <ui.Svg source={d.source} alt={d.alt} />
    }
    const kit = ui as Kit
    const cols = e.props.bodyColumns
    const team = await onStage($)
    const main = await mainRow($, await read($, busy))
    if (!snap && !n) return <kit.Text color="subtle">Measuring the session…</kit.Text>
    return (
      <kit.Box flexDirection="column" gap={1}>
        {snap && (
          <kit.Box flexDirection="column">
            <kit.Text color="subtle" bold>CONTEXT</kit.Text>
            {contextLine(kit, snap, info, cols)}
            <kit.Box flexWrap="wrap" columnGap={2}>
              {snap.rows.filter(r => r.tokens > 0).map(r => (
                <kit.Text>
                  <kit.Text color={catColor(r.label)}>{'● '}</kit.Text>
                  <kit.Text color="subtle">{`${r.label} `}</kit.Text>
                  <kit.Text>{fmtTokens(r.tokens)}</kit.Text>
                </kit.Text>
              ))}
            </kit.Box>
          </kit.Box>
        )}
        {n && (
          <kit.Box flexDirection="column">
            <kit.Text color="subtle" bold>{`GOALS · ${n.goals.length}`}</kit.Text>
            {goalLines(kit, n, cols, true)}
          </kit.Box>
        )}
        {n && attention(n, ctx).length > 0 && (
          <kit.Box flexDirection="column">
            <kit.Text color="subtle" bold>NEEDS YOU</kit.Text>
            {attentionLines(kit, attention(n, ctx))}
          </kit.Box>
        )}
        {agentLine(kit, team, 50, main)}
        {n?.now && (
          <kit.Box flexDirection="column">
            <kit.Text color="subtle" bold>NOW</kit.Text>
            <kit.Text>{n.now}</kit.Text>
          </kit.Box>
        )}
      </kit.Box>
    )
  })
}
