export type ContextRow = { label: string; tokens: number; color: string }

// One MCP server's share: its tool schemas in the window, summed.
export type McpServerRow = { name: string; tokens: number; tools: number; deferred: number }

export type ContextSnapshot = {
  rows: ContextRow[]
  used: number
  free: number
  buffer: number
  max: number
  compactsAt: number | null
  mcpServers: McpServerRow[]
  // US dollars the session has cost so far; null where the host keeps no ledger.
  costUsd: number | null
}

// The model the main loop last asked, and how hard: from each request it sends.
export type RunInfo = { model: string; effort: string | null }

export type GoalStatus = 'active' | 'done' | 'parked'

// One objective the session has pursued, as the goal model keeps it across turns.
export type Goal = {
  // Stable across refreshes: "g1", "g2", ... in the order they appeared.
  id: string
  title: string
  // 0..100: the model's estimate of how far the goal is from done.
  progress: number
  status: GoalStatus
  // The user turn (1-based) in which the goal first appeared.
  firstTurn: number
  // User turns spent on it so far.
  turns: number
}

export type Note = {
  goals: Goal[]
  // The goal the latest exchanges worked on.
  activeId: string | null
  now: string
  // What waits on the person's attention, 0 to 3 short items.
  waiting: string[]
  bullets: string[]
  // The user turn the note was written after.
  turn: number
}

export type Exchange = {
  prompt: string
  tools: string[]
  answer: string
}

// A subagent the main loop started, while it runs and once it ends.
export type AgentRow = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  // Model requests the subagent has made so far.
  steps: number
  // Its latest tool call, as a short line ("Read: src/auth.ts"), and that tool's name.
  lastAction?: string
  lastTool?: string
  // Between a model request starting and its tool call: the model is thinking.
  isThinking?: boolean
  // When it finished, by the session clock: the row stays a moment to show how it ended.
  endedAt?: number
  // Self-reported through savvy-progress's `step` tool, when the agent reports.
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

// What the main loop is up to, most pressing first: each has its own Clawd.
export type MainMood = 'working' | 'stopped' | 'needs' | 'agents' | 'idle'

// The main loop as the agents section draws it, above its subagents.
export type MainRow = {
  model: string
  effort: string | null
  // Its latest tool call this turn, as a short line; null before the first.
  action: string | null
  tools: number
  isBusy: boolean
  mood: MainMood
  // Subagents still running.
  waitingOn: number
}

// full: context, every open goal and what needs you; compact: all of it on one line.
export type DashMode = 'full' | 'compact'

declare module 'claude-code' {
  interface PluginState {
    dashboard: {
      snapshot: ContextSnapshot | null
      run: RunInfo | null
      // Tokens in the window at the last readings, oldest first.
      history: number[]
      note: Note | null
      log: Exchange[]
      mode: DashMode
      isHidden: boolean
      agents: AgentRow[]
      // Whether the main loop is mid-turn: from its requests to its answer.
      busy: boolean
      // Whether the /dashboard panel is up: the band steps aside while it is.
      paneUp: boolean
      // The person interrupted the last turn; cleared by their next prompt.
      stopped: boolean
    }
  }
}
