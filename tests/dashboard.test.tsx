import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { groupSmall } from '../hooks/context'

const USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const ORIGIN = { kind: 'composer' } as const
const band = (isWorking = false, bodyColumns = 120) => ({ hasSurvey: false, isWorking, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} }) as never
const cmd = (args = '') => ({ command: 'dashboard', args, origin: ORIGIN, presentation: { isFullscreen: false, columns: 100 } }) as never

const breakdown = {
  categories: [
    { name: 'System prompt', tokens: 5000, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 283000, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 679000, color: 'inactive', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33000, color: 'inactive', isDeferred: false, kind: 'buffer' },
  ],
  totalTokens: 288000,
  rawMaxTokens: 1_000_000,
  mcpTools: [{ serverName: 'Claude_Browser', tokens: 11000, isLoaded: true }],
  isAutoCompactEnabled: false,
}

const NOTE = {
  goals: [
    { id: 'g1', title: 'Fork savvy-progress', progress: 100, status: 'done' },
    { id: 'g2', title: 'Build the dashboard mod', progress: 60, status: 'active' },
  ],
  active: 'g2',
  now: 'Writing the dashboard tests',
  waiting: ['Pick the visual style', 'Run /reload-plugins'],
  bullets: ['Band draws'],
}

const world = (on: On) => {
  const clock = mock.clock(on, { now: 1 })
  on('session.usage', async () => ({ value: { context: { breakdown }, cost: { usd: 11.89 } } }) as never)
  on('session.measure', async () => ({ changed: ['context'] }))
  on('session.turns', () => ({ value: 0 }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>engine-band</Text>
  })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: JSON.stringify(NOTE), usage: USAGE } }))
  return clock
}

const ready = async ($: Engine) => {
  await $.session.measure({ context: {}, rateLimits: [], changed: ['context'] } as never)
  await $.prompt.submit({ text: 'build the dashboard', wait: false, origin: ORIGIN })
  await $.turn.complete({ answer: 'Which style do you want?', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.command.run(cmd('text'))
}

const draw = async ($: Engine, surface: 'terminal' | 'desktop', props = band()) => {
  const ui = await $.ui.mount({ plugin: 'dashboard', surface, component: 'AbovePrompt', props })
  const json = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return json
}

test('before anything is measured the band leaves the slot to the plugins beneath', async ($, on) => {
  world(on)
  const json = await draw($, 'terminal')
  expect(json).toContain('engine-band')
  expect(json).not.toContain('Context')
})

test('desktop draws one SVG with the window bar, open goals and what needs you, over the bands beneath', async ($, on) => {
  world(on)
  await ready($)
  const json = await draw($, 'desktop')
  expect(json).toContain('"type":"Svg"')
  expect(json).toContain('Context')
  expect(json).toContain('29%')
  expect(json).toContain('Build the dashboard mod')
  expect(json).toContain('1 done: Fork savvy-progress')
  expect(json).toContain('Pick the visual style')
  expect(json).toContain('prefers-color-scheme: dark')
  expect(json).toContain('engine-band')
  // While Claude works, what needs the person waits.
  expect(await draw($, 'desktop', band(true))).not.toContain('Pick the visual style')
})

test('terminal draws the same rows in text with theme colors', async ($, on) => {
  world(on)
  await ready($)
  const json = await draw($, 'terminal')
  expect(json).not.toContain('"type":"Svg"')
  expect(json).toContain('Context  ')
  expect(json).toContain('Build the dashboard mod')
  expect(json).toContain('1 done: Fork savvy-progress')
  expect(json).toContain('"color":"suggestion"')
  expect(json).toContain('"color":"warning"')
  expect(json).toContain('Run /reload-plugins')
})

test('compact puts it all on one line; text lists the goals; the panel draws on every surface', async ($, on) => {
  world(on)
  on('store.set', () => ({ value: undefined }))
  await ready($)
  expect((await $.command.run(cmd('compact'))).text).toMatch(/compact/)
  const json = await draw($, 'desktop')
  expect(json).toContain('2 need you')
  expect((await $.command.run(cmd('text'))).text).toMatch(/Build the dashboard mod/)
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const pane = await $.ui.mount({ plugin: 'dashboard', surface, component: 'Pane', requestId: 'dashboard', props: { title: 'Dashboard', isFocused: false, bodyColumns: 60, placement: 'inline' } as never })
    const p = JSON.stringify(await pane.drawn())
    expect(p).toContain('Build the dashboard mod')
    expect(p).toMatch(/NEEDS YOU|Needs you|NEEDS/i)
    await pane.unmount()
  }
})

test('a running subagent gets a row while it runs, shows how it ended, then leaves', async ($, on) => {
  const clock = world(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }) as never)
  await ready($)
  const r = await $.agent.spawn({ subagentType: 'Explore', description: 'List the mods folder', tool_use_id: 't9', prompt: 'x', provider: { plugin: 'engine', tier: 'core' } } as never)
  expect(r).toMatchObject({ agentId: 'a1' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const json = await draw($, surface)
    expect(json).toContain('List the mods folder')
    expect(json).toContain('Sonnet 5.5')
  }
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't9', reason: 'answer', agentId: 'a1' } as never)
  const ended = await draw($, 'terminal')
  expect(ended).toContain('List the mods folder')
  expect(ended).toContain('✓ ')
  await clock.advance(3100)
  expect(await draw($, 'terminal')).not.toContain('List the mods folder')
})

test('an agent that reports its steps gets a real bar; one that does not shows its latest action', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ agentId: 'a2', model: 'claude-opus-5-5' }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  await ready($)
  await $.agent.spawn({ subagentType: 'Explore', description: 'Map the auth flow', tool_use_id: 't7', prompt: 'x', provider: { plugin: 'engine', tier: 'core' } } as never)
  await $.tool.call({ tool: 'Read', file_path: 'src/auth.ts', agentId: 'a2' } as never)
  let json = await draw($, 'terminal')
  expect(json).toContain('Read: src/auth.ts')
  await $.tool.call({ tool: 'mcp__savvy-progress__step', done: 2, total: 5, note: 'tracing tokens', agentId: 'a2' } as never)
  json = await draw($, 'terminal')
  expect(json).toContain('2/5 · tracing tokens')
  expect(await draw($, 'desktop')).toContain('2/5')
})

test('categories under 4k fold into "others"', () => {
  const snap = { rows: [{ label: 'messages', tokens: 283000, color: 'x' }, { label: 'memory files', tokens: 1000, color: 'x' }, { label: 'mcp tools', tokens: 3000, color: 'x' }, { label: 'agents', tokens: 1000, color: 'x' }], used: 288000, free: 0, buffer: 0, max: 1_000_000, compactsAt: null, mcpServers: [], costUsd: null }
  const g = groupSmall(snap)
  expect(g.rows.map(r => `${r.label} ${r.tokens}`)).toEqual(['messages 283000', 'others 5000'])
  expect(groupSmall({ ...snap, rows: snap.rows.slice(0, 2) }).rows.length).toBe(2)
})

test('a short band drops the legend and titles first and keeps the context row', async ($, on) => {
  world(on)
  await ready($)
  // Two rows more than the bare rows need: the frame's top and bottom edges.
  const tall = await draw($, 'terminal', { ...(band(false, 120) as object), maxRows: 12 } as never)
  expect(tall).toContain('GOALS')
  const short = await draw($, 'terminal', { ...(band(false, 120) as object), maxRows: 6 } as never)
  expect(short).toContain('Context  ')
  expect(short).not.toContain('GOALS')
  expect(short).toContain('Build the dashboard mod')
})

// A 2x2 Laptop in clawd-desk's cache format, 20 frames, the pixel at the bottom right blinking.
const SPRITES = `Laptop:{cat:"Reactive",w:2,h:2,fps:12,palette:["#d97757","#141413"],base:"00.0",deltas:[${Array.from({ length: 19 }, (_, i) => `"${i % 2 ? '3.' : '31'}"`).join(',')}],a0:[]`
// One 2x2 toy sprite per name, in the cache's format, with enough frames for any pose's range.
const toy = (name: string) => `${name}:{cat:"Core",w:2,h:2,fps:12,palette:["#d97757","#141413"],base:"00.0",deltas:[${Array.from({ length: 80 }, (_, i) => `"${i % 2 ? '3.' : '31'}"`).join(',')}],a0:[]`
const CAST = ['JumpingHappy', 'Thinking', 'LookingAround', 'Confetti', 'Disappointed', 'Meditating', 'Waving', 'Hula', 'Dizzy'].map(toy).join(',')
const DESK = `Desktop:{cat:"Reactive",w:2,h:2,fps:12,palette:["#d97757","#2e9e7e","#ffcc00"],base:"0011",deltas:[${Array.from({ length: 80 }, (_, i) => `"${i % 4 < 2 ? '32' : '31'}"`).join(',')}],a0:[]`

// A full-height terminal: room for the main loop's row as well as its agents'.
const tall = (isWorking: boolean) => ({ ...(band(isWorking) as object), maxRows: 30 }) as never

test('the main loop heads the agents: its latest tool while it works, waiting while its agents run', async ($, on) => {
  const clock = world(on)
  mock.env(on, { HOME: '/h' })
  on('fs.read', () => ({ value: `${SPRITES},${DESK},${CAST}` }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }) as never)
  on('tool.call', () => ({ result: 'x', text: 'x' }) as never)
  on('turn.step', async function* () {
    return { answer: '', toolUses: [] } as never
  })
  await $.session.start({ cwd: '/code/x', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  await ready($)
  await $.prompt.submit({ text: 'map the mods', wait: false, origin: ORIGIN })
  await $.tool.call({ tool: 'Read', file_path: 'hooks/register.tsx' } as never)
  await $.agent.spawn({ subagentType: 'Explore', description: 'List the mods folder', tool_use_id: 't9', prompt: 'x', provider: { plugin: 'engine', tier: 'core' } } as never)

  // The terminal keeps to text: no pictures, the main loop and its agent each on two lines.
  const working = await draw($, 'terminal', tall(true))
  expect(working).not.toContain('"type":"Raster"')
  expect(working).toContain('"main"')
  expect(working).toContain('Opus 5.5')
  expect(working).toMatch(/1 tool/)
  expect(working).toContain('List the mods folder')
  // Idle with things in NEEDS YOU, the main loop says so before it says it waits on agents.
  expect(await draw($, 'terminal', tall(false))).toContain('needs you')

  // Desktop: Clawd at the computer while main works; the agent, with no step yet, hops.
  const desk = await draw($, 'desktop', tall(true))
  expect(desk).toContain('#kdesktop')
  expect(desk).toContain('#khop')
  expect(desk).toContain('main · Opus 5.5')
  // The agent's pose follows what it does: thinking on a request, looking on a read, at the
  // laptop on an edit.
  for await (const _ of $.turn.step({ agentId: 'a1', model: 'claude-sonnet-5-5' } as never)) void _
  await clock.settle()
  expect(await draw($, 'desktop', tall(true))).toContain('#kthinking')
  await $.tool.call({ tool: 'Grep', pattern: 'clawd', agentId: 'a1' } as never)
  expect(await draw($, 'desktop', tall(true))).toContain('#klook')
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b', agentId: 'a1' } as never)
  expect(await draw($, 'desktop', tall(true))).toContain('#klaptop')
  // Idle: main waves for what needs the person.
  expect(await draw($, 'desktop', tall(false))).toContain('#kwave')
  // It fails: the agent is disappointed a moment.
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't9', reason: 'error', agentId: 'a1' } as never)
  expect(await draw($, 'desktop', tall(false))).toContain('#kdisappointed')
})

test('with no subagents the main loop still heads the agents, waiting for you', async ($, on) => {
  const clock = world(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('fs.read', () => ({ value: '' }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ cwd: '/code/x', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  // Measured, but no note yet: nothing needs the person.
  await $.session.measure({ context: {}, rateLimits: [], changed: ['context'] } as never)
  const json = await draw($, 'terminal', tall(false))
  expect(json).toContain('AGENTS')
  expect(json).toContain('waiting for you')
  expect(await draw($, 'desktop', tall(false))).toContain('waiting for you')
})

test('an interrupted turn leaves main dizzy until the next prompt', async ($, on) => {
  const clock = world(on)
  mock.env(on, { HOME: '/h' })
  on('fs.read', () => ({ value: `${SPRITES},${DESK},${CAST}` }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ cwd: '/code/x', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  await $.session.measure({ context: {}, rateLimits: [], changed: ['context'] } as never)
  await $.prompt.submit({ text: 'do the thing', wait: false, origin: ORIGIN })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 't1', reason: 'answer' } as never)
  expect(await draw($, 'terminal', tall(false))).toContain('interrupted')
  expect(await draw($, 'desktop', tall(false))).toContain('#kdizzy')
  await $.prompt.submit({ text: 'try again', wait: false, origin: ORIGIN })
  expect(await draw($, 'terminal', tall(false))).not.toContain('interrupted')
})

test('while the panel is up the band steps aside, and comes back when it closes', async ($, on) => {
  world(on)
  let up = false
  on('ui.open', () => {
    up = true
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => {
    up = false
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: up ? [{ id: 'dashboard', title: 'Dashboard', isShown: true, isFocused: true, isPlaced: true }] : [] }) as never)
  await ready($)
  expect((await $.command.run(cmd())).text).toMatch(/opened/)
  const hidden = await draw($, 'terminal')
  expect(hidden).toContain('engine-band')
  expect(hidden).not.toContain('Context')
  expect((await $.command.run(cmd())).text).toMatch(/closed/)
  expect(await draw($, 'terminal')).toContain('Context')
})

test('the full terminal band sits in a rounded frame titled with the mod name; compact stays one bare line', async ($, on) => {
  world(on)
  on('store.set', () => ({ value: undefined }))
  await ready($)
  const full = await draw($, 'terminal', tall(false))
  expect(full).toContain('"borderStyle":"round"')
  expect(full).toContain(' dashboard ')
  await $.command.run(cmd('compact'))
  const compact = await draw($, 'terminal', tall(false))
  expect(compact).not.toContain('"borderStyle":"round"')
})
